# sqlite-ts failing tests grouped by query behavior — with expected SQL

Regenerated from a fresh `npm test` run (Vitest, full suite) on 2026-06-25.

**Current failing tests: 751 across 16 files** (down from 819 at the previous snapshot).

Each file below starts with a summary table grouping its failing tests by query
*behavior* (not the thrown error), followed by the failing tests in each group. For
every group there is a **representative** example showing the EdgeQL, the relevant
ESDL, and the **expected SQL** the engine *should* generate — derived from the schema +
EdgeQL + Gel semantics and the engine's physical layout, not from running the (broken)
query. See the layout conventions note below.

## Failure counts per file

| Count | File |
|---:|---|
| 141 | tests/edgeql_functions.test.ts |
| 128 | tests/edgeql_expressions.test.ts |
| 83 | tests/edgeql_select.test.ts |
| 77 | tests/edgeql_scope.test.ts |
| 74 | tests/edgeql_functions_inline.test.ts |
| 63 | tests/edgeql_select_interpreter.test.ts |
| 39 | tests/edgeql_insert.test.ts |
| 35 | tests/edgeql_linkprops.test.ts |
| 29 | tests/edgeql_calls.test.ts |
| 23 | tests/edgeql_advtypes.test.ts |
| 19 | tests/edgeql_for.test.ts |
| 18 | tests/edgeql_expr_aliases.test.ts |
| 15 | tests/edgeql_linkatoms.test.ts |
| 4 | tests/edgeql_filter.test.ts |
| 2 | tests/edgeql_userddl.test.ts |
| 1 | tests/dump01.test.ts |

## Physical layout conventions used in the expected SQL

- Object type `Foo` (module `default`) → table `"default__foo"` with `"id"` + one column per single scalar property.
- Every projected source carries a literal discriminator `'default::Foo' AS "__source_type"`.
- Link storage is **schema-dependent** (grounded per-section via `bin/inspect.ts`): a **single** link `bar` is usually stored inline as a `"bar_id"` FK column on the source table, but uses a junction table when it carries link properties; a **multi** link always uses a junction table `"default__foo__bar"` (`source`, `target`, `rowid`, + link-property columns). Backlinks read the same junction in reverse.
- A multi scalar property is stored either as a JSON-array column on the source table (read via `json_each`) or as its own value table — see the relevant section for the schema in question.
- Nested object shape → correlated `json_group_array(json_object(...))`; single cardinality wrapped in `json_extract(COALESCE(<arr>,'[]'), '$[0]')`.
- `FILTER .x = $0` → existential `WHERE EXISTS (SELECT 1 FROM (SELECT ? AS "value") WHERE "value" = a0."x")` (EdgeQL `=` is set-valued).
- Set literal `{1,2,3}` → `(SELECT ? AS "value" UNION ALL SELECT ? UNION ALL SELECT ?)`; empty set → 0-row source.
- Aliases shown in canonical `a0/a1/a2…` form (renamed by first appearance), matching `bin/inspect.ts sql`.




---

## tests/edgeql_functions.test.ts (141)

| Count | Query group | Pattern |
|---:|---|---|
| 44 | date/time/duration/calendar funcs | `to_datetime` / `cal::to_local_*` / `duration_truncate` / `range_unpack` over temporal types — string parsing, tz handling, calendar arithmetic |
| 15 | array access/mutation (get/fill/replace/set/insert/join) | `array_get` / `array_fill` / `array_replace` / `array_set` / `array_insert` / `array_join` — element-typed and tuple/array-element variants |
| 14 | aggregates (count/sum/min/max/all/any) | `count` / `sum` / `min` / `max` / `all` / `any` over sets, objects, and non-numeric scalars |
| 11 | cast/bytes/encoding conversion | `<bytes>` ↔ str/json/int/uuid round-trips, `to_bytes`/`to_intN`/`to_uuid`, `enc::base64_*` |
| 11 | math/numeric/trig funcs | `math::sin/cos/tan/cot/acos/asin/atan/atan2/exp/ln/lg/log/var/stddev` numeric precision + range checks |
| 9 | array_agg / array_unpack over objects/tuples/FOR | `array_agg` of objects, FOR-arrays, tuples, empty set; `array_unpack` element-`IN` |
| 8 | enumerate() | `enumerate()` over objects, tuples, nested sets, aggregates, multi-properties |
| 8 | string predicates / numeric rounding | `len` / `contains` / `find` / `str_lower/upper/title` / `str_pad_*` / `str_trim*` / `round` over multi-sets and edge cases |
| 7 | cast/conversion to_str (format strings) | `to_str(x, fmt)` Postgres-style datetime/numeric format templates |
| 6 | complex object/union signatures | UDF calls with `File | URL` union args, type-name-as-function (`str()`/`int32()`), `sys::approximate_count` |
| 5 | regex funcs | `re_match` / `re_match_all` / `re_test` — capture groups, multi-match arrays |
| 3 | generate_series / sequence / bitwise | `_gen_series`, `sequence_reset`, `bit_count` |

### date/time/duration/calendar funcs (44)

- `test_edgeql_functions_unix_to_datetime_01`
- `test_edgeql_functions_unix_to_datetime_02`
- `test_edgeql_functions_unix_to_datetime_03`
- `test_edgeql_functions_unix_to_datetime_04`
- `test_edgeql_functions_unix_to_datetime_05`
- `test_edgeql_functions_datetime_current_02`
- `test_edgeql_functions_date_get_02`
- `test_edgeql_functions_time_get_02`
- `test_edgeql_functions_duration_trunc_03`
- `test_edgeql_functions_duration_trunc_04`
- `test_edgeql_functions_duration_trunc_05`
- `test_edgeql_functions_to_datetime_01`
- `test_edgeql_functions_to_datetime_02`
- `test_edgeql_functions_to_datetime_03`
- `test_edgeql_functions_to_datetime_04`
- `test_edgeql_functions_to_datetime_05`
- `test_edgeql_functions_to_datetime_06`
- `test_edgeql_functions_to_local_datetime_01`
- `test_edgeql_functions_to_local_datetime_02`
- `test_edgeql_functions_to_local_datetime_03`
- `test_edgeql_functions_to_local_datetime_04`
- `test_edgeql_functions_to_local_datetime_05`
- `test_edgeql_functions_to_local_datetime_06`
- `test_edgeql_functions_to_local_datetime_07`
- `test_edgeql_functions_to_local_date_01`
- `test_edgeql_functions_to_local_date_02`
- `test_edgeql_functions_to_local_date_03`
- `test_edgeql_functions_to_local_date_04`
- `test_edgeql_functions_to_local_date_05`
- `test_edgeql_functions_to_local_time_01`
- `test_edgeql_functions_to_local_time_02`
- `test_edgeql_functions_to_local_time_03`
- `test_edgeql_functions_to_local_time_04`
- `test_edgeql_functions_to_local_time_05`
- `test_edgeql_functions_to_local_time_06`
- `test_edgeql_functions_to_local_time_07`
- `test_edgeql_functions_to_local_time_08`
- `test_edgeql_functions_to_duration_02`
- `test_edgeql_functions_duration_normalize_01`
- `test_edgeql_functions_duration_normalize_02`
- `test_edgeql_functions__datetime_range_buckets`
- `test_edgeql_functions_range_unpack_04`
- `test_edgeql_functions_range_unpack_05`
- `test_edgeql_functions_range_unpack_06`

**Representative:** `test_edgeql_functions_unix_to_datetime_02`

**EdgeQL:**
```edgeql
SELECT <str>to_datetime(1590595184);
-- expected result: "2020-05-27T15:59:44+00:00"
```

**Relevant ESDL:** (none)

**Expected SQL:**
```sql
-- to_datetime(<unix epoch seconds>) must build a UTC ISO-8601 timestamp,
-- then <str> renders it with a "+00:00" offset (note: NOT a trailing "Z").
-- SQLite's strftime with the 'unixepoch' modifier converts the epoch seconds:
SELECT (
  strftime('%Y-%m-%dT%H:%M:%f', 1590595184, 'unixepoch') || '+00:00'
) AS "value";
-- For the fractional-seconds variant (to_datetime(1590595184.584)) the .584 ms
-- must be preserved; for the .00n bigint/decimal variant the value casts to
-- numeric epoch seconds first. Out-of-range epochs (to_datetime(999999999999))
-- must raise "'std::datetime' value out of range".
```

**Why it fails today:** `std::to_datetime` is registered runtime-only (no `sql:` template) and goes through `parseDateTime`; the single-numeric-arg unix-epoch overload, the multi-arg `to_datetime(y,m,d,...,tz)` overload, the format-string overload, and the whole `cal::to_local_*` / `duration_truncate` / `range_unpack` temporal family are not lowered to SQL (no SQLite UDF emits the correct ISO rendering, tz conversion, or calendar truncation), so the str rendering / arithmetic diverges or errors. (`duration_trunc_01` now passes; only the `'hours'`/`'minutes'` and edge-unit variants `03/04/05` remain.)

### array access/mutation (get/fill/replace/set/insert/join) (15)

- `test_edgeql_functions_array_get_03`
- `test_edgeql_functions_array_get_06`
- `test_edgeql_functions_array_fill_01`
- `test_edgeql_functions_array_fill_02`
- `test_edgeql_functions_array_fill_03`
- `test_edgeql_functions_array_fill_04`
- `test_edgeql_functions_array_fill_05`
- `test_edgeql_functions_array_replace_03`
- `test_edgeql_functions_array_replace_04`
- `test_edgeql_functions_array_replace_05`
- `test_edgeql_functions_array_set_01b`
- `test_edgeql_functions_array_insert_01b`
- `test_edgeql_functions_array_join_02`
- `test_edgeql_functions_array_join_03`
- `test_edgeql_functions_array_join_04`

**Representative:** `test_edgeql_functions_array_join_02`

**EdgeQL:**
```edgeql
SELECT array_join(['one', 'two', 'three'], {', ', '@!'});
-- expected (multi separator → multi result): {'one, two, three', 'one@!two@!three'}
```

**Relevant ESDL:** (none)

**Expected SQL:**
```sql
-- array_join(arr, sep): registry template walks the array via json_each and
-- group_concat's the elements. With a MULTI separator the call multiplies out
-- over each separator value (cross join against the separator set source):
SELECT (
  WITH __aj(__arr) AS (VALUES (json_array(?, ?, ?)))
  SELECT COALESCE(group_concat(value, "sep"), '')
  FROM __aj, json_each(__aj.__arr)
) AS "value"
FROM (SELECT ? AS "sep" UNION ALL SELECT ? AS "sep");
-- The bytes overload (array_join([b'one',...], b', ')) must concatenate BLOBs,
-- not TEXT, and return bytes; <array<bytes>>[] must yield b''.
```

**Why it fails today:** `array_join`'s `sql:` template handles a single scalar separator but the operand here is a **multi-set** separator (`{', ', '@!'}`) that must distribute element-wise (one result per separator); the bytes variants (`b', '`, `b''`, empty `<array<bytes>>[]`) need BLOB concatenation rather than TEXT `group_concat`. Sibling failures: `array_fill` / `array_set` / `array_insert` of array/tuple elements hit the `record[] is not supported` path; `array_replace` of tuple/array elements and `array_get` with tuple elements / huge index (`2^40`) aren't lowered correctly.

### aggregates (count/sum/min/max/all/any) (14)

- `test_edgeql_functions_count_01`
- `test_edgeql_functions_count_02`
- `test_edgeql_functions_count_03`
- `test_edgeql_functions_sum_04`
- `test_edgeql_functions_sum_05`
- `test_edgeql_functions_sum_07`
- `test_edgeql_functions_sum_08`
- `test_edgeql_functions_min_01`
- `test_edgeql_functions_min_03`
- `test_edgeql_functions_max_01`
- `test_edgeql_functions_max_03`
- `test_edgeql_functions_max_04`
- `test_edgeql_functions_all_01`
- `test_edgeql_functions_any_03`

**Representative:** `test_edgeql_functions_min_01`

**EdgeQL:**
```edgeql
SELECT min({'10', '20', '-3', '4'});   -- str ordering → '-3'
SELECT min({10, 2.5, -3.1, 4});        -- numeric → -3.1
SELECT min(<int64>{});                  -- empty set → {}
```

**Relevant ESDL:** (none)

**Expected SQL:**
```sql
-- min/max over a scalar set is the SQLite aggregate over the element source.
-- The element source carries the value under "value":
SELECT (
  SELECT min("value")
  FROM (SELECT ? AS "value" UNION ALL SELECT ? AS "value"
        UNION ALL SELECT ? AS "value" UNION ALL SELECT ? AS "value")
) AS "value";
-- For STRINGS, SQLite's min() already does lexicographic ordering, but the
-- result must come back typed as str (not coerced to a number). For min(<int64>{})
-- the source is 0-row, so min() yields NULL → serialized as the empty set {}.
```

**Why it fails today:** `std::min`/`std::max` use the SQLite `min()`/`max()` aggregate, but the failing cases need type-faithful comparison/return: `min`/`max` over a `str` set must compare and return as text (and `min({'10','hello',...})` must not numerify); `min(User)`/`max(User)` (`min_03`/`max_03`/`max_04`) aggregate over **objects** (min by id), which the scalar aggregate can't express; `sum` over `duration`/`relative_duration`/`date_duration` (`sum_05/07/08`) has no numeric lowering; `sum_04` and `all_01`/`any_03` need correct result-type inference / empty-set and boolean-fold semantics. `count_01/02/03` compare a computed-shape `count` field against `count(x.all_issues)` where the augmented-object shape isn't resolved.

### cast/bytes/encoding conversion (11)

- `test_edgeql_functions_string_bytes_conversion`
- `test_edgeql_functions_string_bytes_conversion_error`
- `test_edgeql_functions_json_bytes_conversion`
- `test_edgeql_functions_int_bytes_conversion_01`
- `test_edgeql_functions_int_bytes_conversion_02`
- `test_edgeql_functions_int_bytes_conversion_03`
- `test_edgeql_functions_int_bytes_conversion_04`
- `test_edgeql_functions_uuid_bytes_conversion_01`
- `test_edgeql_functions_uuid_bytes_conversion_02`
- `test_edgeql_functions_encoding_base64_fuzz`
- `test_edgeql_functions_encoding_base64_bad`

**Representative:** `test_edgeql_functions_int_bytes_conversion_02`

**EdgeQL:**
```edgeql
SELECT to_int16(b'\x01', Endian.Big)         -- error: not enough bytes for int16
SELECT to_int16(to_bytes(<int32>123, Endian.Big), Endian.Big)  -- error: 4 bytes for int16
```

**Relevant ESDL:** (none)

**Expected SQL:**
```sql
-- to_intN(bytes, endian) lowers through the _gel_to_intN SQLite UDF, passing the
-- enum's value as the endian selector. The bytes literal b'\x01' is a BLOB:
SELECT _gel_to_int16(CAST(? AS BLOB), 'Big') AS "value";
-- to_bytes(<int16>val, Endian.Big) must emit the matching big/little-endian BLOB,
-- so the round-trip to_int16(to_bytes(v, e), e) = v holds. A wrong-width input
-- (1 byte / 4 bytes for int16) must raise a decode error, and base64_decode("~")
-- / base64_decode("AA") (unpadded) must raise the matching base64 errors.
```

**Why it fails today:** `to_int16/32/64`, `to_bytes`, `to_uuid`, and `enc::base64_encode/decode` either lack a complete byte-level UDF, do not thread the `Endian.Big/Little` enum argument into the `_gel_to_intN` template, or do not raise the width/padding decode errors — so endian round-trips and the error-path expectations diverge. (`array_fill_02/03/05`-style `record[]` errors also surface in `to_bytes` of tuple-valued inputs.)

### math/numeric/trig funcs (11)

- `test_edgeql_functions_math_exp_03`
- `test_edgeql_functions_math_log_01`
- `test_edgeql_functions_math_var_03`
- `test_edgeql_functions_math_acos_01`
- `test_edgeql_functions_math_asin_01`
- `test_edgeql_functions_math_atan_01`
- `test_edgeql_functions_math_atan2_01`
- `test_edgeql_functions_math_cos_01`
- `test_edgeql_functions_math_cot_01`
- `test_edgeql_functions_math_sin_01`
- `test_edgeql_functions_math_tan_01`

**Representative:** `test_edgeql_functions_math_sin_01`

**EdgeQL:**
```edgeql
SELECT math::sin(-math::pi() * 2);   -- expected ≈ 0.0 (exact reference value)
SELECT math::cos(-math::pi());       -- expected -1.0
```

**Relevant ESDL:** (none)

**Expected SQL:**
```sql
-- Trig funcs lower to the _gel_* SQLite UDFs; pi() is the SQLite pi() builtin:
SELECT _gel_sin((-(pi()) * 2)) AS "value";
-- The challenge is float64 precision: the result must match Postgres' float8
-- output rounding (e.g. sin(-2π) prints as a specific value, not a raw IEEE
-- double), and NaN/±inf inputs must propagate to {} (empty set), not NULL/NaN.
```

**Why it fails today:** the `_gel_sin/cos/tan/cot/acos/asin/atan` UDFs return raw JS `Math.*` doubles whose textual/float rendering doesn't match Postgres `float8` output (and `NaN`/`±inf` results should collapse to the empty set). `math::var`/`stddev` (`var_03`), `math::ln/lg/log` (`log_01`), and `math::exp` (`exp_03`, incl. `<decimal>` and `'inf'`) likewise diverge on precision / overflow / decimal handling.

### array_agg / array_unpack over objects/tuples/FOR (9)

- `test_edgeql_functions_array_agg_05`
- `test_edgeql_functions_array_agg_09`
- `test_edgeql_functions_array_agg_10`
- `test_edgeql_functions_array_agg_13`
- `test_edgeql_functions_array_agg_18`
- `test_edgeql_functions_array_agg_20`
- `test_edgeql_functions_array_agg_23`
- `test_edgeql_functions_array_unpack_04`
- `test_edgeql_functions_array_unpack_06`

**Representative:** `test_edgeql_functions_array_agg_13`

**EdgeQL:**
```edgeql
SELECT
    Issue {
        number,
        watchers_array := array_agg(Issue.watchers {name})
    }
FILTER EXISTS Issue.watchers
ORDER BY Issue.number;
```

**Relevant ESDL:**
```esdl
type Issue extending Named, Owned, Text {
    required number: issue_num_t;
    optional multi watchers: User;   # junction default__issue__watchers(source,target,rowid)
}
type User extending Dictionary { ... }   # has scalar `name`
```

**Expected SQL:**
```sql
-- array_agg over an object shape builds a json_group_array of json_object rows,
-- correlated to the outer Issue via the watchers junction table:
SELECT
  a0."number" AS "number",
  (SELECT json_group_array(json("value"))
   FROM (
     SELECT json_object('name', t0."name") AS "value"
     FROM "default__issue__watchers" aJ
     JOIN (SELECT "id" AS "id", "name" AS "name" FROM "default__user") t0
       ON t0."id" = aJ."target"
     WHERE aJ."source" = a0."id"
     ORDER BY aJ."rowid"
   )) AS "watchers_array"
FROM (SELECT 'default::Issue' AS "__source_type", "id" AS "id", "number" AS "number"
      FROM "default__issue") a0
WHERE EXISTS (SELECT 1 FROM "default__issue__watchers" w WHERE w."source" = a0."id")
ORDER BY a0."number";
```

**Why it fails today:** `array_agg` is registry runtime-only (no `sql:`), so aggregating an **object shape** inside another object shape (`array_agg(Issue.watchers {name})`), aggregating a **FOR** body (`array_agg_10`), tuples (`array_agg_23`), `schema::ObjectType.properties` with a nested FILTER/ORDER BY (`array_agg_09`), `Issue.time_estimate UNION 3000` (`array_agg_20`), and the empty-set `array_agg({})` (`array_agg_05/18`) aren't compiled to the correlated `json_group_array` form. `array_unpack_04/06` (round-trip `array_unpack(array_agg(...))` and element-`IN array_unpack([...])`) depend on the same missing unpack/agg SQL.

### enumerate() (8)

- `test_edgeql_functions_enumerate_02`
- `test_edgeql_functions_enumerate_03`
- `test_edgeql_functions_enumerate_04`
- `test_edgeql_functions_enumerate_05`
- `test_edgeql_functions_enumerate_06`
- `test_edgeql_functions_enumerate_07`
- `test_edgeql_functions_enumerate_08`
- `test_edgeql_functions_enumerate_09`

**Representative:** `test_edgeql_functions_enumerate_03`

**EdgeQL:**
```edgeql
SELECT enumerate((SELECT User.name ORDER BY User.name));  -- {(0,'Elvis'),(1,'Yury')}
SELECT enumerate({(1, 2), (3, 4)});                       -- {(0,(1,2)),(1,(3,4))}
WITH A := {'a', 'b'} SELECT (A, enumerate(A));
```

**Relevant ESDL:** (`enumerate_03` is scalar; `enumerate_05` uses `User { name }` — see schema above)

**Expected SQL:**
```sql
-- enumerate(set) pairs each element with its 0-based index via a window function,
-- emitting a 2-tuple [idx, value]; ORDER BY inside fixes the index assignment:
SELECT json_array((row_number() OVER () ) - 1, "value") AS "value"
FROM (
  SELECT a0."name" AS "value"
  FROM (SELECT "id" AS "id", "name" AS "name" FROM "default__user") a0
  ORDER BY a0."name"
);
-- For tuple elements ({(1,2),(3,4)}) the value side must itself be json_array(1,2)
-- so the result is [0,[1,2]]; for object elements (enumerate(User{name})) the value
-- is json(json_object('name', ...)).
```

**Why it fails today:** `enumerate` has no `sql:` template and only a runtime impl; while a simple scalar `enumerate({'a','b','c'})` lowers, the failing cases (preserving ORDER BY index, tuple/object elements, nested `enumerate(enumerate(...))` in `enumerate_07`, multi-property `Issue.time_estimate` in `enumerate_08`, aggregate args `sum`/`count`/`array_agg` in `enumerate_09`, and `<json>` rendering in `enumerate_04`) need the `row_number()`-over-source lowering with correct value wrapping that isn't produced.

### string predicates / numeric rounding (8)

- `test_edgeql_functions_len_01`
- `test_edgeql_functions_round_02`
- `test_edgeql_functions_round_04`
- `test_edgeql_functions_contains_01`
- `test_edgeql_functions_find_03`
- `test_edgeql_functions_str_case_01`
- `test_edgeql_functions_str_pad_01`
- `test_edgeql_functions_str_trim_01`

**Representative:** `test_edgeql_functions_str_case_01`

**EdgeQL:**
```edgeql
SELECT str_lower({'HeLlO', 'WoRlD!', 'ПриВет', 'мИр'});
SELECT str_title({'HeLlO', 'WoRlD!'});
```

**Relevant ESDL:** (none)

**Expected SQL:**
```sql
-- str_lower/upper lower to SQLite lower()/upper() over each element of the set
-- source. With a MULTI argument the call distributes element-wise:
SELECT lower(COALESCE(CAST("value" AS TEXT), '')) AS "value"
FROM (SELECT ? AS "value" UNION ALL SELECT ? AS "value"
      UNION ALL SELECT ? AS "value" UNION ALL SELECT ? AS "value");
-- KEY: SQLite's lower()/upper() are ASCII-only, so 'ПриВет'→'привет' (Cyrillic)
-- needs a Unicode-aware fold; str_title has no SQLite builtin and needs a UDF.
```

**Why it fails today:** SQLite `lower()`/`upper()` only fold ASCII, so Unicode inputs (`'ПриВет'`) aren't cased correctly, and `str_title` has no SQLite builtin (no `sql:` template at all). Siblings: `str_pad_start/end` and `str_trim*` over multi-sets / multi-char pad strings, `len` over a `{str}` multi-set (`len_01` q3 `__std__::len`), `contains`/`find` with empty-set / array-of-array args and set-valued needles, and `round` result-type inference (`round_02`) + ordering over `<int64>`/`<decimal>` divisions (`round_04`).

### cast/conversion to_str (format strings) (7)

- `test_edgeql_functions_to_str_01`
- `test_edgeql_functions_to_str_02`
- `test_edgeql_functions_to_str_03`
- `test_edgeql_functions_to_str_04`
- `test_edgeql_functions_to_str_05`
- `test_edgeql_functions_to_str_06`
- `test_edgeql_functions_to_str_07`

**Representative:** `test_edgeql_functions_to_str_05`

**EdgeQL:**
```edgeql
SELECT to_str(123456789, '999,999,999');   -- expected "123,456,789"
SELECT to_str(123456789, 'FM999,999,999,999');  -- expected "123,456,789"
SELECT to_str(123456789, 'S999,999,999,999');    -- expected "+123,456,789"
```

**Relevant ESDL:** (none)

**Expected SQL:**
```sql
-- to_str(numeric, fmt) and to_str(datetime, fmt) require a Postgres-style
-- to_char() format-string engine. The single-arg form lowers to CAST(... AS TEXT)
-- (registry template), but the 2-arg form needs a dedicated UDF:
SELECT _gel_to_char(123456789, '999,999,999') AS "value";
-- It must implement PG patterns: digit groups (9/0), thousands ',', sign 'S',
-- fill-mode 'FM', and datetime patterns (YYYY-MM-DD, FMMonth, CC, A.M., TZH/TZM).
```

**Why it fails today:** the `std::to_str` registry template is only `CAST(<arg> AS TEXT)` — it ignores the optional second **format-string** argument entirely. The numeric (`to_str_05/06`) and datetime/date/time (`to_str_01/02/03/04/07`) format-string overloads need a `to_char`-equivalent UDF (PG number masks and date templates), which doesn't exist, so any `to_str(x, fmt)` returns the bare cast instead of the formatted string.

### complex object/union signatures (6)

- `test_edgeql_call_type_as_function_01`
- `test_edgeql_functions_complex_types_01`
- `test_edgeql_functions_complex_types_02`
- `test_edgeql_functions_complex_types_03`
- `test_edgeql_functions_complex_types_04`
- `test_edgeql_functions_approximate_count`

**Representative:** `test_edgeql_functions_complex_types_02`

**EdgeQL:**
```edgeql
create function foo(x: str) -> optional File | URL using (
    select {File, URL} filter .name = x limit 1
);
select foo("screenshot.png").name;   -- "screenshot.png"
select foo("edgedb.com").name;        -- "edgedb.com"
select foo({"edgedb.com", "screenshot.png"}).name;
```

**Relevant ESDL:**
```esdl
type File extending Named;                       # has `name`
type URL extending Named { required address: str; }   # has `name`, `address`
```

**Expected SQL:**
```sql
-- A UDF returning a polymorphic union (File | URL) inlines to a UNION ALL over
-- the concrete branches, each tagged with its __source_type discriminator, then
-- the outer `.name` reads the (shared, inherited) name column post-union:
SELECT (
  SELECT u."name"
  FROM (
    SELECT 'default::File' AS "__source_type", "id" AS "id", "name" AS "name"
    FROM "default__file"
    UNION ALL
    SELECT 'default::URL' AS "__source_type", "id" AS "id", "name" AS "name"
    FROM "default__url"
  ) u
  WHERE u."name" = ?
  LIMIT 1
) AS "value";
```

**Why it fails today:** UDF inlining of a function whose return type is an object **union** (`File | URL`) plus a trailing `.name`/no-shape projection isn't resolved — the polymorphic branch expansion + `__source_type` tagging + inherited-column read across the union isn't produced. `call_type_as_function_01` (`str(1)`, `int32(1)`, `cal::local_date(1)`) needs type-names usable as cast-functions, and `approximate_count` needs `sys::approximate_count(introspect T)` over the schema/extent.

### regex funcs (5)

- `test_edgeql_functions_re_match_01`
- `test_edgeql_functions_re_match_02`
- `test_edgeql_functions_re_match_all_01`
- `test_edgeql_functions_re_test_01`
- `test_edgeql_functions_re_test_02`

**Representative:** `test_edgeql_functions_re_match_01`

**EdgeQL:**
```edgeql
SELECT re_match('(?i)AB', 'AbabaB');   -- expected ['Ab'] (array<str> of groups/whole match)
SELECT re_match('ac', 'AbabaB');        -- expected {} (no match → empty set)
SELECT EXISTS re_match('ac', 'AbabaB'); -- false
```

**Relevant ESDL:** (none)

**Expected SQL:**
```sql
-- re_match lowers through the _gel_re_match_first UDF; the result is an
-- array<str> (capture groups, or the whole match when no groups). A non-match
-- yields NULL → serialized as the empty set {}:
SELECT _gel_re_match_first(?, ?) AS "value";
-- re_test lowers to (_gel_re_test(?, ?) = 1); re_match_all must return a SET of
-- arrays (one per match), which has no sql: template yet.
```

**Why it fails today:** `re_match`/`re_test` lower through `_gel_re_*` UDFs but the result shaping diverges — `re_match` must return an `array<str>` of capture groups (empty set on no match) and `re_match_all` (no `sql:` template) must return a **set of arrays** per match. `re_match_02`/`re_test_02` run over `schema::ObjectType.name` (introspection extent) with backslash-escaped patterns and ORDER BY/count, which the regex-over-foreign-extent path doesn't compile. (Several are also tagged xerror "Known collation issue on Heroku Postgres".)

### generate_series / sequence / bitwise (3)

- `test_edgeql_functions__genseries_01`
- `test_edgeql_functions_sequence_next_reset`
- `test_edgeql_functions_bitwise_15`

**Representative:** `test_edgeql_functions__genseries_01`

**EdgeQL:**
```edgeql
SELECT _gen_series(1, 10)       -- {1,2,3,4,5,6,7,8,9,10}
SELECT _gen_series(1, 10, 2)    -- {1,3,5,7,9}
SELECT _gen_series(1n, 10n)     -- bigint series
```

**Relevant ESDL:** (none)

**Expected SQL:**
```sql
-- _gen_series(start, stop[, step]) is a set-returning function → a row source.
-- It should lower to a recursive CTE producing one "value" row per element:
SELECT "value" FROM (
  WITH RECURSIVE __gs("value") AS (
    SELECT 1
    UNION ALL
    SELECT "value" + 1 FROM __gs WHERE "value" + 1 <= 10
  )
  SELECT "value" FROM __gs
);
-- The 3-arg form uses step (+ 2); the bigint (1n) form keeps integer semantics.
```

**Why it fails today:** `_gen_series` is not lowered to a row-producing source (inspect emits a placeholder `SELECT NULL AS "id"` — the set-returning recursive-CTE form is missing), so it yields no rows. `sequence_reset(INTROSPECT my_seq_01[, n])` needs sequence-object support, and `bit_count(<intN>val)` (`bitwise_15`) needs the `_gel_bit_count` UDF to honor the int width across int16/32/64.



---

## tests/edgeql_expressions.test.ts (128)

| Count | Query group | Pattern |
|---:|---|---|
| 23 | Cross-type validity matrices | Generated `<a> op <b>` over scalar type pairs; valid combos compute / `IS <type>`, invalid throw `cannot be applied to operands` |
| 21 | Range & multirange constructors / bounds / casts / JSON | `range(...)`, `multirange(...)`, empty ranges, `range_get_*`, cross-type casts, `<json>` round-trip |
| 9 | Error-only diagnostics (parse / type / overflow) | `toThrow(...)` for malformed literals, scalar index, bad casts, stack overflow, id assignment |
| 9 | Tuple equality / indirection / named tuples | `(...) = (...)`, named-tuple field/positional access, nested-tuple indirection through `[0]`, decimal eq |
| 9 | Array construction / index / concat / nested | nested `array<array<...>>`, `++`, array-of-tuple, empty-element collapse, element-wise collection cast |
| 7 | `assert*` family | `assert`, `assert_single`, `assert_exists`, `assert_distinct` with messages, params, shapes |
| 7 | IF...ELSE conditional | set-valued branches/conditions, chained `IF`, parameterized condition, implicit-cast common type |
| 7 | Cardinality singleton violations | `ORDER BY`/`LIMIT`/`OFFSET`/`DISTINCT`/`UNION`/`EXISTS` over a multi path must throw singleton error |
| 6 | WITH aliases & alias projections | `WITH a := {...}`, alias as shape computed, union of aliased object sets |
| 5 | String escapes / line continuation / interpolation | `\`-newline collapse, invalid escape errors, `\(expr)` interpolation, raw-bytes literals |
| 5 | Membership `IN` / `NOT IN` | element-wise `_ IN {set}`, with WITH-bound set / subquery / empty set |
| 4 | Casts (scalar & collection) | tuple→array error, computed-shape division common type, float/decimal UNION error, cast-to-function error |
| 4 | Path interpretation / partial-path errors | `SELECT .1`, `Issue.number changes the interpretation of Issue` |
| 4 | DISTINCT / set-op over tuples & objects | `DISTINCT {(), ()}`, incompatible set-constructor types, schema-object UNION |
| 4 | Params / variables | positional/named params, `OPTIONAL`/`REQUIRED`, `?? default`, `<array<T>>$x` |
| 3 | Introspection / TYPEOF | `INTROSPECT TYPEOF`, `INTROSPECT TYPEOF BaseObject`, introspect-collection error |
| 1 | Empty-set propagation | `<int64>{} + 1` collapses whole expr to `[]` |

### Cross-type validity matrices (23)

- `test_edgeql_expr_valid_eq_03`
- `test_edgeql_expr_valid_comp_02`
- `test_edgeql_expr_valid_order_01`
- `test_edgeql_expr_valid_order_06`
- `test_edgeql_expr_valid_arithmetic_05`
- `test_edgeql_expr_valid_arithmetic_06`
- `test_edgeql_expr_valid_arithmetic_07`
- `test_edgeql_expr_valid_arithmetic_08`
- `test_edgeql_expr_valid_arithmetic_10`
- `test_edgeql_expr_valid_arithmetic_12`
- `test_edgeql_expr_valid_setop_01`
- `test_edgeql_expr_valid_setop_02`
- `test_edgeql_expr_valid_setop_04`
- `test_edgeql_expr_valid_setop_05`
- `test_edgeql_expr_valid_setop_06`
- `test_edgeql_expr_valid_setop_07`
- `test_edgeql_expr_valid_setop_08`
- `test_edgeql_expr_valid_setop_09`
- `test_edgeql_expr_valid_setop_10`
- `test_edgeql_expr_valid_setop_11`
- `test_edgeql_expr_valid_setop_12`
- `test_edgeql_expr_valid_setop_14`
- `test_edgeql_expr_valid_bool_01`

These are generated by looping over the `VALUES` scalar matrix at the top of the file and applying an operator to every left/right type pair (`=`/`!=`/`<`/`>=`, arithmetic `+ - * / // % ^`, `UNION`, `??`, `IF ELSE`, `AND`/`OR`/`NOT`, `ORDER BY`). Valid pairs must compute and frequently satisfy an `IS <type>` / `INTROSPECT TYPEOF` result-type assertion; invalid pairs must `toThrow(/cannot be applied to operands/)` (or `/operator 'X' cannot be applied/`). Each instantiated query is a tiny scalar expression — the work is in operator resolution and result-type inference.

**Representative:** `test_edgeql_expr_valid_arithmetic_08`

**EdgeQL:**
```edgeql
SELECT <bigint>1 + <float64>1;              -- throws: numeric + float invalid
SELECT (<bigint>1 + <int64>1) IS bigint;    -- [true]: numeric + int preserves numeric
SELECT (<decimal>1.0 / <int64>1) IS decimal;-- [true]
```

**Expected SQL:** (the invalid arm must never reach SQL — it errors at compile time. The valid `IS` arm resolves the type check at compile time:)
```sql
-- SELECT (<bigint>1 + <int64>1) IS bigint;
SELECT json('true') AS "value"
-- the arithmetic itself, if materialized: SELECT (1 + 1) AS "value"
```

**Why it fails today:** the operator-resolution / result-type matrix is incomplete or too permissive — invalid pairs (e.g. `bigint + float64`, `UNION` of incompatible scalars, unary `-` on `uuid`, non-bool `AND`) aren't rejected with the expected error, and/or valid pairs infer the wrong result type so the `IS <type>` assertion returns the wrong boolean.

### Range & multirange constructors / bounds / casts / JSON (21)

- `test_edgeql_expr_range_empty_01`
- `test_edgeql_expr_range_empty_02`
- `test_edgeql_expr_range_empty_03`
- `test_edgeql_expr_range_17`
- `test_edgeql_expr_range_24`
- `test_edgeql_expr_range_29`
- `test_edgeql_expr_range_30`
- `test_edgeql_expr_range_31`
- `test_edgeql_expr_range_33`
- `test_edgeql_expr_range_34`
- `test_edgeql_expr_range_35`
- `test_edgeql_expr_range_37`
- `test_edgeql_expr_range_41`
- `test_edgeql_expr_range_42`
- `test_edgeql_expr_range_43`
- `test_edgeql_expr_range_50`
- `test_edgeql_expr_range_51`
- `test_edgeql_expr_range_52`
- `test_edgeql_expr_range_53`
- `test_edgeql_expr_range_54`
- `test_edgeql_expr_range_55`

The residual range/multirange tail: empty-range construction (`range(<T>{}, empty := true)`), conflicting-args errors, cross-type range/multirange casts, getters with inclusive-bound normalization on discrete types, range-with-empty-optional-param collapsing to `[]`, and `<json>` serialization / `<range<T>>to_json(...)` deserialization (including ranges nested in free-objects and multiranges normalized/sorted ascending).

**Representative:** `test_edgeql_expr_range_50`

**EdgeQL:**
```edgeql
SELECT (
  range(<int64>{}, empty := true),
  range(1, 4),
  range(<int64>{}, 4),
  range(1),
);
-- → [[ {empty:true},
--      {lower:1, inc_lower:true,  upper:4,    inc_upper:false},
--      {lower:null, inc_lower:false, upper:4, inc_upper:false},
--      {lower:1, inc_lower:true,  upper:null, inc_upper:false} ]]
```

**Expected SQL:** a 4-element tuple of ranges; each range built via the `_gel_range` runtime fn, then JSON-encoded as a tuple:
```sql
SELECT (SELECT json_array(t0, t1, t2, t3) FROM (SELECT
    _gel_range(NULL, NULL, NULL, NULL, 1, 1) AS t0,  -- empty := true
    _gel_range(1, 4, NULL, NULL, 1)          AS t1,
    _gel_range(NULL, 4, 0, NULL, 1)          AS t2,  -- unbounded lower
    _gel_range(1, NULL, NULL, NULL, 1)       AS t3   -- unbounded upper
)) AS "value"
```
(Confirmed idioms: `range(2,10)` → `_gel_range(2, 10, NULL, NULL, 1)`; `<json>range(...)` wraps the same in `json_quote`; `multirange([...])` → `_gel_multirange(json_array(_gel_range(...)))`; `range_is_empty(...)` → `_gel_range_is_empty(...)`; `range_get_upper(...)` → `_gel_range_get_upper(...)`.)

**Why it fails today:** `range(<T>{}, empty := true)` and the unbounded-bound combinations aren't all constructed/encoded correctly; several subcases throw at parse time on `empty :=` / unbounded args, mis-order multirange normalization, or fail to round-trip range↔JSON with discrete inclusive-upper normalization.

### Error-only diagnostics (parse / type / overflow) (9)

- `test_edgeql_expr_literals_02`
- `test_edgeql_expr_array_05`
- `test_edgeql_expr_array_20`
- `test_edgeql_expr_array_04`
- `test_edgeql_expr_cannot_assign_id_01`
- `test_edgeql_expr_error_after_extraction_01`
- `test_edgeql_normalization_mismatch_01`
- `test_edgeql_overflow_error`
- `test_edgeql_expr_invalid_object_scalar_op_01`

All assert `toThrow(<regex>)` for queries that must be rejected: out-of-range/malformed literals and durations, indexing a scalar via a multi index expr, array index by float (`2^40`), empty `[]`/`{}` of indeterminate type, assigning `id`, a tokenizer error (`'''1'''`), a deep `+` chain overflowing the compiler stack, and a scalar op (`??`) on an object.

**Representative:** `test_edgeql_expr_array_04`

**EdgeQL:**
```edgeql
SELECT [];   -- throws: expression returns value of indeterminate type
```

**Expected SQL:** none — the query must fail at compile time with `expression returns value of indeterminate type`. No SQL should be emitted.

**Why it fails today:** the engine emits SQL (or throws the wrong error) instead of the specific compile-time diagnostic — e.g. it accepts the empty/indeterminate literal or scalar index rather than rejecting it.

### Tuple equality / indirection / named tuples (9)

- `test_edgeql_expr_tuple_02`
- `test_edgeql_expr_tuple_06`
- `test_edgeql_expr_tuple_07`
- `test_edgeql_expr_tuple_09`
- `test_edgeql_expr_tuple_indirection_09`
- `test_edgeql_expr_tuple_indirection_12`
- `test_edgeql_expr_tuple_indirection_14`
- `test_edgeql_expr_op_20`
- `test_edgeql_expr_op_21`

Tuple `=`/`!=` (with implicit numeric promotion, positional comparison of named tuples), named-tuple field/positional access (incl. through `[0]`), deep nested-tuple indirection, rejection of tuple-vs-scalar / position-mismatch operators. `op_20` (`(10+math::floor(random()))^308` near float64 max + overflow) and `op_21` (high-precision decimal equality) are unique scalar one-offs grouped here.

**Representative:** `test_edgeql_expr_tuple_06`

**EdgeQL:**
```edgeql
SELECT (1, 'foo') = (a := 1, b := 'foo');   -- [true] (named compared positionally)
```

**Expected SQL:** each tuple is JSON-encoded element-wise, then compared as JSON values:
```sql
SELECT (SELECT CASE WHEN l IS NULL OR r IS NULL THEN NULL
                    WHEN l = r THEN json('true') ELSE json('false') END
        FROM (SELECT
          (SELECT CASE WHEN t0 IS NULL OR t1 IS NULL THEN NULL
                       ELSE json_array(t0, t1) END
           FROM (SELECT 1 AS t0, 'foo' AS t1)) AS l,
          (SELECT CASE WHEN t0 IS NULL OR t1 IS NULL THEN NULL
                       ELSE json_array(t0, t1) END
           FROM (SELECT 1 AS t0, 'foo' AS t1)) AS r
        )) AS "value"
```

**Why it fails today:** named-tuple comparison/field access and nested-tuple indirection through `[0]` aren't fully lowered (named keys not flattened to positional, or `.1.0` deep paths over a set produce wrong order); position-mismatch tuples (`tuple_07`) don't raise the expected error.

### Array construction / index / concat / nested (9)

- `test_edgeql_expr_array_concat_03`
- `test_edgeql_expr_array_09`
- `test_edgeql_expr_array_10`
- `test_edgeql_expr_array_25`
- `test_edgeql_expr_array_27`
- `test_edgeql_expr_implicit_cast_06`
- `test_edgeql_expr_cast_05`
- `test_edgeql_expr_cast_09`
- `test_edgeql_expr_cast_10`

Nested `array<array<...>>` construction/index/slice/concat, array-of-named-tuple with `FILTER X[0].foo`, very large array literals (300 elements), implicit element-type unification across a set of tuples, and element-wise collection casts (incl. enum-element and named-tuple casts).

**Representative:** `test_edgeql_expr_array_concat_03`

**EdgeQL:**
```edgeql
SELECT [(1, 'a')] ++ [(2.0, $$\$$), (3.0, r'\n')];
-- → [[[1,"a"],[2,"\\"],[3,"\\n"]]]   (element 0 promoted int->float)
```

**Expected SQL:** concat two json arrays of tuple-encoded elements:
```sql
SELECT (SELECT json_group_array(value)
        FROM (SELECT value FROM json_each(json_array(json_array(1, 'a')))
              UNION ALL
              SELECT value FROM json_each(json_array(json_array(2.0, '\'),
                                                     json_array(3.0, '\n'))))) AS "value"
```
(Confirmed idiom: `[1,2] ++ [3]` → `json_group_array` over `json_each(...) UNION ALL json_each(...)`.)

**Why it fails today:** mixing element types across the two array literals (int vs float in element 0) isn't unified to a common element type before concat, and array-of-tuple element encoding / nested-array depth isn't preserved through `++`.

### `assert*` family (7)

- `test_edgeql_assert_single_01`
- `test_edgeql_assert_single_02`
- `test_edgeql_assert_message_crossproduct`
- `test_edgeql_assert_exists_01`
- `test_edgeql_assert_distinct_01`
- `test_edgeql_assert_01`
- `test_edgeql_assert_02`

`assert_single`/`assert_exists`/`assert_distinct`/`assert` are identity functions that throw a violation when their cardinality/truth contract is broken; tests check both the pass-through result and the `message :=` override, including in shapes, over parameters, and in FOR/filter clauses.

**Representative:** `test_edgeql_assert_exists_01`

**EdgeQL:**
```edgeql
SELECT assert_exists(
  (SELECT User { name } FILTER .name IN {"User 1", "User 2"})
) ORDER BY .name;
-- → [{name:"User 1"}, {name:"User 2"}]
-- also: SELECT assert_exists(<str>{});  -- throws "assert_exists violation"
```

**Relevant ESDL:**
```esdl
type User extending Dictionary;   # Dictionary -> required name: str
```

**Expected SQL:** `assert_exists` is a pass-through over the row source plus a non-empty guard; the shape `{ name }` projects the scalar column:
```sql
SELECT json_object('name', a0."name") AS "value"
FROM (SELECT 'default::User' AS "__source_type", "id" AS "id", "name" AS "name"
      FROM "default__user") a0
WHERE a0."name" IN (?, ?)
ORDER BY a0."name"
-- runtime additionally enforces ">= 1 row" (assert_exists violation otherwise);
-- assert_exists({1,2}) is just SELECT 1 AS "value" UNION ALL SELECT 2 AS "value".
```

**Why it fails today:** the assert wrappers don't fully enforce/propagate the violation (and custom `message :=`), or the cross-product of messages multiplies results; some subcases over empty sets / shapes don't raise the expected violation text.

### IF...ELSE conditional (7)

- `test_edgeql_expr_if_else_02`
- `test_edgeql_expr_if_else_03`
- `test_edgeql_expr_if_else_04`
- `test_edgeql_expr_if_else_05`
- `test_edgeql_expr_if_else_06`
- `test_edgeql_expr_if_else_11`
- `test_edgeql_expr_implicit_cast_04`

Set-valued THEN/ELSE branches and set-valued conditions produce a cross-product of element-wise CASE results; chained `IF ... ELSE ... IF ...`; parameterized condition; implicit int→float common-type cast across branches (`implicit_cast_04`: `3 / (2 IF True ELSE 2.0)` → `1.5`).

**Representative:** `test_edgeql_expr_if_else_02`

**EdgeQL:**
```edgeql
SELECT 'yes' IF True ELSE {'no', 'or', 'maybe'};            -- ["yes"]
SELECT 'yes' IF {True, False} ELSE {'no', 'or', 'maybe'};   -- ["yes","no","or","maybe"]
```

**Expected SQL:** the THEN source is emitted where the condition is true, UNION ALL the ELSE source where false:
```sql
WITH cond_raw AS (SELECT json('true') AS "r"),
     cond_q AS (SELECT (CASE WHEN "r" IN (1,'true') THEN 1
                             WHEN "r" IN (0,'false') THEN 0 ELSE NULL END) AS "c"
                FROM cond_raw)
SELECT "value" FROM (SELECT 'yes' AS "value") WHERE (SELECT "c" FROM cond_q)
UNION ALL
SELECT "value" FROM (SELECT 'no' AS "value" UNION ALL SELECT 'or' AS "value"
                     UNION ALL SELECT 'maybe' AS "value")
WHERE NOT (SELECT "c" FROM cond_q)
```

**Why it fails today:** the set-valued condition / branch cross-product and chained-`IF` element-wise correlation aren't produced correctly (a singleton condition is assumed), or the common-type cast across branches is missing for `implicit_cast_04`.

### Cardinality singleton violations (7)

- `test_edgeql_expr_cardinality_01`
- `test_edgeql_expr_cardinality_02`
- `test_edgeql_expr_cardinality_03`
- `test_edgeql_expr_cardinality_04`
- `test_edgeql_expr_cardinality_05`
- `test_edgeql_expr_cardinality_06`
- `test_edgeql_expr_cardinality_07`

Clauses requiring a singleton (`ORDER BY`, `LIMIT`, `OFFSET`, and the `DISTINCT`/`UNION`/`EXISTS`/`IN` subject ordering) fed a multi-cardinality path must throw `possibly more than one element returned by an expression where only singletons are allowed`.

**Representative:** `test_edgeql_expr_cardinality_02`

**EdgeQL:**
```edgeql
SELECT Issue LIMIT LogEntry.spent_time;
-- throws: possibly more than one element returned by an expression
--         where only singletons are allowed
```

**Relevant ESDL:**
```esdl
type LogEntry extending Owned, Text { required spent_time: int64; }
type Issue extending Named, Owned, Text { multi time_spent_log: LogEntry; ... }
```

**Expected SQL:** none — must fail cardinality inference at compile time (`LogEntry.spent_time` is multi, `LIMIT` requires a singleton). No SQL emitted.

**Why it fails today:** cardinality inference for these clause arguments doesn't flag the multi source — the engine compiles to SQL (likely taking an arbitrary row) instead of raising the singleton-cardinality error.

### WITH aliases & alias projections (6)

- `test_edgeql_expr_alias_01`
- `test_edgeql_expr_alias_02`
- `test_edgeql_expr_alias_04`
- `test_edgeql_expr_alias_05`
- `test_edgeql_expr_alias_06`
- `test_edgeql_expr_set_02`

`WITH a := {...}` bindings, an alias used as the SELECT subject with a FILTER referencing another binding, a nested `WITH` inside a shape computed field, and union of WITH-bound object sets projected with `.name` and ordered.

**Representative:** `test_edgeql_expr_alias_01`

**EdgeQL:**
```edgeql
WITH a := {1, 2}, b := {2, 3}
SELECT a FILTER a = b;   -- [2]
```

**Expected SQL:** both bindings are set sources; the filter is an existential equality between them:
```sql
SELECT a0."value" AS "value"
FROM (SELECT 1 AS "value" UNION ALL SELECT 2 AS "value") a0
WHERE EXISTS (
  SELECT 1 FROM (SELECT 2 AS "v" UNION ALL SELECT 3 AS "v")
  WHERE "v" = a0."value")
```

**Why it fails today:** cross-binding existential filters and WITH-bindings used inside shape-computed fields aren't fully resolved — the binding reference loses its set source or the FILTER over a sibling binding isn't applied.

### String escapes / line continuation / interpolation (5)

- `test_edgeql_expr_string_09`
- `test_edgeql_expr_string_10`
- `test_edgeql_expr_string_11`
- `test_edgeql_expr_str_interpolation_01`
- `test_edgeql_expr_bytes_op_03`

Backslash-newline line-continuation collapses to nothing in normal strings (raw strings preserve it), invalid `\ ` escapes error, `\(expr)` string interpolation desugars to `++ <str>expr`, and raw-bytes (`rb`/`br`) literal concat.

**Representative:** `test_edgeql_expr_str_interpolation_01`

**EdgeQL:**
```edgeql
SELECT "1 + 1 = \(1 + 1)";   -- ["1 + 1 = 2"]
```

**Expected SQL:** interpolation desugars to string concat with the inner expression cast to `str`:
```sql
SELECT ('1 + 1 = ' || CAST((1 + 1) AS TEXT)) AS "value"
```

**Why it fails today:** the `\(expr)` interpolation isn't desugared with an implicit `<str>` cast — inspect shows `operator '++' cannot be applied to operands of type 'std::str' and 'std::int64'`, i.e. the interpolated int isn't coerced to str before concatenation.

### Membership `IN` / `NOT IN` (5)

- `test_edgeql_expr_op_14`
- `test_edgeql_expr_op_15`
- `test_edgeql_expr_op_16`
- `test_edgeql_expr_op_17`
- `test_edgeql_expr_op_19`

Element-wise `_ IN {set}` / `_ NOT IN {set}` filters, including over a `WITH`-bound set, a `len(...)` subquery, and an empty set (`1 IN <int64>{}` → false; param-into-empty → `[]`).

**Representative:** `test_edgeql_expr_op_14`

**EdgeQL:**
```edgeql
SELECT _ := {9, 1, 13} FILTER _ IN {11, 12, 13};   -- {13}
```

**Expected SQL:** the candidate set is the row source; the `IN` filter is an existential over the set literal:
```sql
SELECT "value" AS "value"
FROM (SELECT 9 AS "value" UNION ALL SELECT 1 AS "value" UNION ALL SELECT 13 AS "value") a0
WHERE EXISTS (
  SELECT 1 FROM (SELECT 11 AS "v" UNION ALL SELECT 12 AS "v" UNION ALL SELECT 13 AS "v")
  WHERE "v" = a0."value")
```

**Why it fails today:** the `IN`/`NOT IN` membership over a set source (and against empty / WITH-bound / subquery sets) isn't lowered to the existential filter — inspect drops the FILTER entirely (returns the full `{9,1,13}` source), so the membership predicate is not applied.

### Casts (scalar & collection) (4)

- `test_edgeql_expr_cast_08`
- `test_edgeql_expr_implicit_cast_07`
- `test_edgeql_expr_implicit_cast_08`
- `test_edgeql_cast_to_function_01`

Tuple→array cast must error, computed-shape float/int division common type, `UNION` of float and decimal must error, and casting to a function name (`<to_str>1`) must error.

**Representative:** `test_edgeql_cast_to_function_01`

**EdgeQL:**
```edgeql
SELECT <to_str>1;   -- throws: "does not exist" (to_str is a function, not a type)
```

**Expected SQL:** none — must fail at compile time: a function name is not a valid cast target.

**Why it fails today:** the cast resolver treats a function symbol as a type (or doesn't error), so `<to_str>` / `<round>` / `<cal::to_local_date>` don't raise `does not exist`; `cast_08`/`implicit_cast_08` similarly fail to reject tuple→array and float/decimal UNION.

### Path interpretation / partial-path errors (4)

- `test_edgeql_expr_paths_03`
- `test_edgeql_expr_paths_06`
- `test_edgeql_expr_paths_08`
- `test_edgeql_expr_paths_09`

A partial path `.1` with no enclosing shape, and DML/shape forms where a second reference like `Issue.number` "changes the interpretation of Issue" must raise the specific binding/interpretation error.

**Representative:** `test_edgeql_expr_paths_06`

**EdgeQL:**
```edgeql
SELECT Issue.owner { foo := Issue.number };
-- throws: 'Issue.number' changes the interpretation of 'Issue'
```

**Relevant ESDL:**
```esdl
type Issue extending Named, Owned, Text {
  overloaded required link owner { property since: datetime; }
  required number: issue_num_t { ... }
}
```

**Expected SQL:** none — must raise the interpretation/path-binding error at compile time. No SQL emitted.

**Why it fails today:** the path-scoping analysis that detects a second reference to `Issue` re-binding the outer set (in a shape body / UPDATE subject) isn't implemented, so the query either compiles or throws the wrong error.

### DISTINCT / set-op over tuples & objects (4)

- `test_edgeql_expr_setop_08`
- `test_edgeql_expr_setop_11`
- `test_edgeql_expr_setop_12`
- `test_edgeql_expr_setop_14`

`DISTINCT` over empty/nested tuples (`DISTINCT {(), ()}` → `[[]]`), set-constructor incompatible-type errors (`setop_14`), schema-object `UNION` (`setop_08`), and DISTINCT-reduces-count assertions (`setop_11`).

**Representative:** `test_edgeql_expr_setop_12`

**EdgeQL:**
```edgeql
SELECT DISTINCT {(), ()};                 -- [[]]
SELECT DISTINCT {(1,(2,3)), (1,(2,3))};   -- [[1,[2,3]]]
```

**Expected SQL:** the tuples are JSON-encoded then de-duplicated:
```sql
SELECT DISTINCT "value" AS "value"
FROM (SELECT json_array() AS "value" UNION ALL SELECT json_array() AS "value")
```

**Why it fails today:** DISTINCT over empty/nested-tuple values doesn't dedupe by encoded value (empty tuple `()` and nested tuples aren't normalized to a comparable JSON form), and the incompatible set-constructor type errors (`setop_14`) aren't raised.

### Params / variables (4)

- `test_edgeql_expr_variables_02`
- `test_edgeql_expr_variables_04`
- `test_edgeql_expr_variables_05`
- `test_edgeql_expr_variables_06`

Positional `$0` and named `$x` params; `REQUIRED` (missing → error) vs `OPTIONAL` (missing → `[]` or `?? default`); `<array<T>>$x` array params; param reused / combined with `INTROSPECT TYPEOF`.

**Representative:** `test_edgeql_expr_variables_04`

**EdgeQL:**
```edgeql
SELECT <int64>$x;                  -- throws "argument $x is required"
SELECT <OPTIONAL int64>$x ?? -1;   -- [-1]  (param unbound -> empty -> coalesce)
SELECT <REQUIRED int64>$x ?? -1;   -- [7]   (param bound to 7)
```

**Expected SQL:** the param is a bind placeholder; `OPTIONAL` makes the source possibly-empty and `??` supplies the default:
```sql
-- SELECT <OPTIONAL int64>$x ?? -1;
SELECT COALESCE((SELECT ? AS "value"), -1) AS "value"
-- a missing REQUIRED param raises "argument $x is required" before SQL runs.
```

**Why it fails today:** required-vs-optional param enforcement and the empty-param `?? default` path aren't handled (missing required param doesn't raise the named error, or an unbound optional doesn't become an empty set), and `<array<T>>$x` decoding is off.

### Introspection / TYPEOF (3)

- `test_edgeql_expr_introspect_bad_01`
- `test_edgeql_introspect_without_shape`
- `test_edgeql_typeop_09`

`INTROSPECT (collection)` must error; `INTROSPECT TYPEOF BaseObject` (no shape) returns a schema object reference with `__tname__`; `typeop_09` reads `(INTROSPECT TYPEOF 1e100n).name` and concatenates it with a param.

**Representative:** `test_edgeql_introspect_without_shape`

**EdgeQL:**
```edgeql
SELECT (INTROSPECT TYPEOF BaseObject);
-- → 1 row; res[0].__tname__ === "schema::ObjectType"
```

**Expected SQL:** introspection resolves to a row from the schema metadata (the `schema::ObjectType` describing `BaseObject`):
```sql
SELECT json_object('id', a0."id", '__tname__', 'schema::ObjectType') AS "value"
FROM (SELECT "id" FROM "schema__objecttype" WHERE "name" = 'std::BaseObject') a0
```

**Why it fails today:** `INTROSPECT TYPEOF` without a shape doesn't return the schema-object reference (missing `__tname__`), and `INTROSPECT (tuple<int64>)` doesn't raise `cannot introspect collection types`.

### Empty-set propagation (1)

- `test_edgeql_expr_emptyset_01`

An empty set as an operand collapses the whole expression to the empty set; bare `SELECT {}` is an indeterminate-type error.

**Representative:** `test_edgeql_expr_emptyset_01`

**EdgeQL:**
```edgeql
SELECT <int64>{} + 1;   -- []
SELECT 1 + <int64>{};   -- []
SELECT {};              -- throws "expression returns value of indeterminate type"
```

**Expected SQL:** the empty-set side is a 0-row source, so the `+` join produces no rows:
```sql
SELECT (a0."value" + 1) AS "value"
FROM (SELECT NULL AS "value" WHERE 0) a0
```

**Why it fails today:** an empty-set operand of a binary op isn't propagated as a 0-row source (engine yields a row with NULL, returning `[null]` instead of `[]`), and bare `SELECT {}` doesn't raise the indeterminate-type error.

---

Total: 23+21+11+9+9+9+7+7+7+6+5+5+4+4+4+4+3+1 = 139 tests across 18 groups.


---

## tests/edgeql_select.test.ts (83)

| Count | Query group | Pattern |
|---:|---|---|
| 11 | select setops (UNION/EXCEPT/INTERSECT) | Set algebra over object/scalar sets, including in FILTER / `?=` / `except`-`intersect` |
| 9 | select polymorphic (`[IS T]` / `Object[IS A\|B]`) | Type-narrowing projection over a heterogeneous base set, incl. universal `Object` |
| 8 | select expr objects (objects in arrays/tuples) | `array_agg(Obj)` / `[Obj]` / `(Obj, …)` then index/unpack/path back into objects |
| 6 | select subqueries (correlated EXISTS) | `FILTER EXISTS (SELECT … FILTER … = OuterRef)` with backlink correlation |
| 5 | select alias indirection | WITH-bound type variant whose computed shape is path-accessed downstream |
| 5 | select cross (cartesian) | Cross product of object/scalar sets via `++`, tuples, nested aggregates |
| 5 | introspection / schema (`schema::`, `__type__`, `introspect`) | Reflection over `schema::ObjectType`/`Function` or `__type__`/`introspect` shapes |
| 4 | collection shape (objects inside arrays/tuples) | Object placed in `[...]`/`(...)` collection then shaped/round-tripped |
| 3 | select computable (multi/computed-link-id) | Computed pointer (`multi m`, `.todo.id`, `[[1]]`) in a shape |
| 3 | select tvariant (type variant) | Shape-local computed link reusing/extending an outer path |
| 3 | select tid position (`*` / `**` splat ordering) | Splat `*`/`**` must emit `__tid__` as first pointer key |
| 3 | free object (DISTINCT / nested) | `SELECT { x := … }` free-object set, distinctness + nested path access |
| 2 | select slice (string/array/json) | `[a:b]` slicing with negative/optional/empty bounds across str/array/json |
| 16 | singletons (one-off behaviors) | Each a distinct failing behavior (see list) |

### select setops (UNION/EXCEPT/INTERSECT) (11)

- `test_edgeql_select_setops_04`
- `test_edgeql_select_setops_10`
- `test_edgeql_select_setops_13a`
- `test_edgeql_select_setops_13b`
- `test_edgeql_select_setops_23`
- `test_edgeql_select_setops_24`
- `test_edgeql_select_setops_27`
- `test_edgeql_select_setops_28`
- `test_edgeql_select_equivalence_02a`
- `test_edgeql_select_equivalence_02b`
- `test_edgeql_select_or_01`

Set operations (UNION / EXCEPT / INTERSECT, plus `?=` / `OR` set-membership) used as, or inside, a FILTER subject over object and computed-scalar sets.

**Representative:** `test_edgeql_select_setops_10`

**EdgeQL:**
```edgeql
# using UNION in a FILTER
SELECT _ := User{name}
FILTER (
    (
        SELECT User.<owner[IS Issue]
    ) UNION (
        # this part should guarantee the filter is always true
        SELECT Issue
        FILTER Issue.number = '1'
    )
).number = '1'
ORDER BY _.name;
```

**Relevant ESDL:**
```esdl
type User extending Dictionary { multi todo: Issue { rank: int64 } }
abstract type Owned { required owner: User { note: str } }
type Issue extending Named, Owned, Text {
    required number: issue_num_t { constraint exclusive }
}
# Owned.owner junction owns the link; backlink User.<owner[IS Issue]
```

**Expected SQL:**
```sql
-- The FILTER subject is a UNION ALL of two object sources (backlink Issues
-- of this User, plus the global Issue #1). The predicate ".number = '1'" is an
-- existential over that union, correlated to the outer User row a0.
SELECT a0."id" AS "id", a0."__source_type" AS "__source_type", a0."name" AS "name"
FROM (SELECT 'default::User' AS "__source_type", "id" AS "id", "name" AS "name"
      FROM "default__user") a0
WHERE EXISTS (
  SELECT 1 FROM (
      -- branch 1: User.<owner[IS Issue]  (backlink, correlated to a0)
      SELECT t0."number" AS "number"
      FROM "default__issue__owner" aJ
      JOIN (SELECT "id","number" FROM "default__issue") t0 ON t0."id" = aJ."source"
      WHERE aJ."target" = a0."id"
    UNION ALL
      -- branch 2: SELECT Issue FILTER .number = '1'  (uncorrelated)
      SELECT a1."number" AS "number"
      FROM (SELECT "id","number" FROM "default__issue") a1
      WHERE a1."number" IN (?)
  ) u
  WHERE u."number" = ?            -- '1'
)
ORDER BY a0."name";
```

**Why it fails today:** a UNION of a correlated backlink branch with an uncorrelated global branch inside a FILTER subject is not decorrelated/correlated correctly (`setops_24/27/28` add `EXCEPT`/`INTERSECT` over computed scalar sets, `equivalence_02a/02b`/`or_01` add `?=`/`OR` set-membership in the same FILTER position).

### select polymorphic (`[IS T]` / `Object[IS A|B]`) (9)

- `test_edgeql_select_polymorphic_04b`
- `test_edgeql_select_polymorphic_07`
- `test_edgeql_select_polymorphic_08`
- `test_edgeql_select_polymorphic_09`
- `test_edgeql_select_polymorphic_10`
- `test_edgeql_select_polymorphic_12`
- `test_edgeql_select_instance_02`
- `test_edgeql_union_target_01`
- `test_edgeql_select_is_13`

**Representative:** `test_edgeql_select_polymorphic_07`

**EdgeQL:**
```edgeql
SELECT Object[IS Status | Priority].name;
# equivalent to: SELECT Object[IS Status].name ?? Object[IS Priority].name;
```

**Relevant ESDL:**
```esdl
abstract type Dictionary extending Named { overloaded required name: str }
type Status extending Dictionary;
type Priority extending Dictionary;
# Object is the universal base; [IS Status | Priority] narrows to those two.
```

**Expected SQL:**
```sql
-- Object expands to a UNION ALL of every concrete object table; the
-- [IS Status|Priority] intersection keeps only rows whose discriminator is
-- one of the named subtypes, projecting their .name (NULL elsewhere, dropped).
SELECT "value" FROM (
  SELECT a0."name" AS "value"
  FROM (
      SELECT 'default::Status' AS "__source_type", "id","name" FROM "default__status"
    UNION ALL
      SELECT 'default::Priority' AS "__source_type", "id","name" FROM "default__priority"
    UNION ALL
      -- ... every other concrete object type, with name = NULL ...
      SELECT 'default::Issue' AS "__source_type", "id", "name" FROM "default__issue"
    UNION ALL
      SELECT 'default::User' AS "__source_type", "id", "name" FROM "default__user"
    -- (etc. for all object types)
  ) a0
  WHERE a0."__source_type" IN ('default::Status', 'default::Priority')
) WHERE "value" IS NOT NULL;
```

**Why it fails today:** narrowing the universal `Object` set with `[IS A|B]` emits a bogus `FROM "default__"` (empty table name) instead of a UNION ALL over the concrete subtypes — `Object`-rooted polymorphism is not expanded. (`polymorphic_09/12` add nested `[IS T].link[IS T2]` shapes; `instance_02`/`is_13` add `IS NOT A|B` / `[Text] IS array<Issue>` runtime type checks.)

### select expr objects (objects in arrays/tuples) (8)

- `test_edgeql_select_expr_objects_01`
- `test_edgeql_select_expr_objects_02`
- `test_edgeql_select_expr_objects_04a`
- `test_edgeql_select_expr_objects_04b`
- `test_edgeql_select_expr_objects_08`
- `test_edgeql_select_array_common_type_01`
- `test_edgeql_select_array_common_type_02`
- `test_edgeql_select_tuple_02`

**Representative:** `test_edgeql_select_expr_objects_02`

**EdgeQL:**
```edgeql
SELECT _ := array_unpack(array_agg(Issue)).owner.name
ORDER BY _;
```

**Relevant ESDL:**
```esdl
abstract type Owned { required owner: User { note: str } }
type Issue extending Named, Owned, Text { ... }
# Issue.owner stored in junction default__issue__owner.
```

**Expected SQL:**
```sql
-- array_agg(Issue) must aggregate object *identities* (ids), array_unpack
-- restores them to a set of Issue rows, then .owner.name hops the owner
-- junction to User. The aggregate/unpack round-trip must preserve identity so
-- the downstream pointer join still resolves against default__issue.
SELECT a0."value" AS "value" FROM (
  SELECT u."name" AS "value"
  FROM (
      -- array_unpack(array_agg(Issue)) == the Issue set, identity-preserving
      SELECT "id" FROM "default__issue"
  ) iss
  JOIN "default__issue__owner" aJ ON aJ."source" = iss."id"
  JOIN (SELECT "id","name" FROM "default__user") u ON u."id" = aJ."target"
) a0
ORDER BY a0."value";
```

**Why it fails today:** `array_agg` of an object set followed by `array_unpack(...).<path>` loses object identity — inspect emits `SELECT NULL AS "id", NULL AS "__source_type"`, so the subsequent `.owner.name` pointer hop has nothing to join against. (`expr_objects_01` indexes `array_agg(Issue ORDER BY .body)[0]`; `array_common_type_01/02` build `[User, Issue]` / `[Object]` arrays of a common supertype; `tuple_02` nests object paths in tuples.)

### select subqueries (correlated EXISTS) (6)

- `test_edgeql_select_subqueries_04`
- `test_edgeql_select_subqueries_07`
- `test_edgeql_select_subqueries_08`
- `test_edgeql_select_subqueries_10`
- `test_edgeql_select_subqueries_14`
- `test_edgeql_select_subqueries_15`

**Representative:** `test_edgeql_select_subqueries_07`

**EdgeQL:**
```edgeql
# find all issues such that there's at least one more
# issue watched by the same user as this one
SELECT Issue{number}
FILTER
    EXISTS Issue.watchers
    AND
    EXISTS (
        (SELECT
            User
         FILTER
            User = Issue.watchers AND
            User.<watchers != Issue
        ).<watchers
    )
ORDER BY
    Issue.number;
```

**Relevant ESDL:**
```esdl
type Issue extending Named, Owned, Text { optional multi watchers: User; }
# watchers stored in junction default__issue__watchers (source=Issue, target=User)
# backlink User.<watchers[IS Issue] swaps the roles.
```

**Expected SQL:**
```sql
-- Outer Issue a0. First conjunct: a0 has any watcher. Second: there is a User
-- who (a) watches a0 and (b) watches some OTHER Issue (User.<watchers != Issue),
-- and that other-watch set is non-empty.
SELECT a0."id" AS "id", a0."__source_type" AS "__source_type", a0."number" AS "number"
FROM (SELECT "id","number" FROM "default__issue") a0
WHERE EXISTS (SELECT 1 FROM "default__issue__watchers" w WHERE w."source" = a0."id")
  AND EXISTS (
    SELECT 1
    FROM "default__user" u
    JOIN "default__issue__watchers" wt ON wt."target" = u."id"      -- User watches a0
    WHERE wt."source" = a0."id"
      AND EXISTS (
        SELECT 1 FROM "default__issue__watchers" wo                 -- User.<watchers
        WHERE wo."target" = u."id" AND wo."source" <> a0."id"       -- != Issue (outer)
      )
  )
ORDER BY a0."number";
```

**Why it fails today:** the inner subquery correlates a User both to the outer `Issue.watchers` membership and back through `User.<watchers != Issue`; the double backlink correlation to the outer `Issue` is not threaded through (`subqueries_14` correlates `Comment.owner = User`, `subqueries_15` nests a third correlated EXISTS for a Comment).

### select alias indirection (5)

- `test_edgeql_select_alias_indirection_04`
- `test_edgeql_select_alias_indirection_05`
- `test_edgeql_select_alias_indirection_08`
- `test_edgeql_select_alias_indirection_10`
- `test_edgeql_select_alias_indirection_11`

**Representative:** `test_edgeql_select_alias_indirection_10`

**EdgeQL:**
```edgeql
WITH
    sub := (
        SELECT
            Text {
                foo := Text.body ++ '!'
            }
        ORDER BY
            len(Text.body) ASC
        LIMIT 1
    )
SELECT
    User {
        name,
        shortest_text_foo := sub.foo
    }
FILTER User.name = 'Elvis';
```

**Relevant ESDL:**
```esdl
abstract type Text { required body: str }
type User extending Dictionary { ... }
# Text is abstract: its set is the UNION of Comment, Issue, LogEntry rows.
```

**Expected SQL:**
```sql
-- `sub` is a singleton WITH-binding: the shortest Text, with a computed
-- scalar field foo = body || '!'. Each User row reads sub.foo (a constant
-- across rows) via a correlated/scalar subquery on the binding's computed shape.
SELECT a0."id" AS "id", a0."__source_type" AS "__source_type",
       a0."name" AS "name",
       (SELECT (s."body" || '!') AS "foo"
        FROM (
            SELECT 'default::Comment' AS "__source_type","id","body" FROM "default__comment"
          UNION ALL
            SELECT 'default::Issue' AS "__source_type","id","body" FROM "default__issue"
          UNION ALL
            SELECT 'default::LogEntry' AS "__source_type","id","body" FROM "default__logentry"
        ) s
        ORDER BY length(s."body") ASC LIMIT 1) AS "shortest_text_foo"
FROM (SELECT 'default::User' AS "__source_type","id","name" FROM "default__user") a0
WHERE EXISTS (SELECT 1 FROM (SELECT ? AS "value") WHERE "value" = a0."name");
```

**Why it fails today:** path access of a WITH-bound type variant's *computed* field (`sub.foo`) from an outer shape drops the binding's computed shape during binding-ref resolution (known recurring blocker; `alias_indirection_04/08/11` are the deeper "computed link inside a variant, accessed downstream" forms; `05` compares two aliased object singletons with `=`).

### select cross (cartesian) (5)

- `test_edgeql_select_cross_04`
- `test_edgeql_select_cross08`
- `test_edgeql_select_cross_10`
- `test_edgeql_select_cross_13`
- `test_edgeql_select_func_05`

**Representative:** `test_edgeql_select_cross08`

**EdgeQL:**
```edgeql
SELECT _ := Issue.owner.name ++ <str>count(Issue.watchers.name)
ORDER BY _;
```

**Relevant ESDL:**
```esdl
abstract type Owned { required owner: User { note: str } }
type Issue extending Named, Owned, Text { optional multi watchers: User; }
# owner in default__issue__owner; watchers in default__issue__watchers.
```

**Expected SQL:**
```sql
-- For each Issue, concat its owner's name with the (per-Issue) count of distinct
-- watcher names. count() is a correlated aggregate scoped to the same Issue row.
SELECT (o."name" || CAST(
          (SELECT count(*) FROM (
              SELECT DISTINCT u."name"
              FROM "default__issue__watchers" wj
              JOIN (SELECT "id","name" FROM "default__user") u ON u."id" = wj."target"
              WHERE wj."source" = a0."id"
          )) AS TEXT)
       ) AS "value"
FROM (SELECT "id" FROM "default__issue") a0
JOIN "default__issue__owner" oj ON oj."source" = a0."id"
JOIN (SELECT "id","name" FROM "default__user") o ON o."id" = oj."target"
ORDER BY "value";
```

**Why it fails today:** a scalar `count(Issue.watchers.name)` must be correlated to the *same* Issue row that supplies `Issue.owner.name` on the other side of `++`; the cross/aggregate correlation collapses the per-row scope (`cross_04` concats owner with backlink Issue numbers, `cross_10/13` nest aggregates `count(count(...))` / `count((Issue, count(...)))`, `func_05` is the VARIADIC `anytype` arg-count error path).

### introspection / schema (`schema::`, `__type__`, `introspect`) (5)

- `test_edgeql_select_type_04`
- `test_edgeql_select_type_05`
- `test_edgeql_select_func_07`
- `test_edgeql_select_tname_overriden_type_01`
- `test_edgeql_select_setops_29`

**Representative:** `test_edgeql_select_type_05`

**EdgeQL:**
```edgeql
SELECT User.__type__ { name };
```

**Relevant ESDL:**
```esdl
type User extending Dictionary { ... }
# .__type__ is the implicit link to schema::ObjectType; .name == 'default::User'.
```

**Expected SQL:**
```sql
-- .__type__ projects each User to its ObjectType meta-row; the {name} shape
-- reads that meta-object's name. With one shared meta-table this is a join from
-- User to schema__objecttype on the type id, DISTINCT over the single User type.
SELECT json_object('id', t."id", '__source_type', 'schema::ObjectType',
                   'name', t."name") AS "value"
FROM (SELECT DISTINCT "__type___id" FROM "default__user") u
JOIN (SELECT "id","name" FROM "schema__objecttype") t ON t."id" = u."__type___id";
-- (or, since name is constant per concrete type, a literal: 'default::User')
```

**Why it fails today:** `__type__` is materialized as a NULL `"__type___id"` column on the object source (see inspect: `NULL AS "__type___id"`) with no schema meta-table to join, so the `{name}` shape over `User.__type__` can't resolve `name` (`type_04` shapes nested `__type__: {name,id}`; `func_07` introspects `schema::Function.params` with nested `[IS schema::Array].element_type`; `setops_29` set-operates over `schema::Object`/`std::BaseObject` meta types; `tname_overriden_type_01` overrides `__type__ := introspect Issue`).

### collection shape (objects inside arrays/tuples) (4)

- `test_edgeql_collection_shape_04`
- `test_edgeql_collection_shape_06`
- `test_edgeql_collection_shape_07`
- `test_edgeql_collection_shape_08`

**Representative:** `test_edgeql_collection_shape_08`

**EdgeQL:**
```edgeql
SELECT X := array_agg(User) FILTER X[0].name != 'Sully';
-- and:
SELECT X := [User] FILTER X[0].name = 'Elvis';
```

**Relevant ESDL:**
```esdl
type User extending Dictionary { ... }   -- has .name (from Named)
```

**Expected SQL:**
```sql
-- X is an array of User objects. The FILTER indexes element 0 and reads its
-- .name, so the array elements must retain object identity to support X[0].name.
-- array_agg(User) -> single-row array of all Users; [User] -> per-User singleton array.
SELECT "value" FROM (
  SELECT (SELECT json_group_array(json_object('id', u."id",
                  '__source_type', u."__source_type", 'name', u."name"))
          FROM (SELECT 'default::User' AS "__source_type","id","name"
                FROM "default__user") u) AS "value"
)
WHERE json_extract("value", '$[0].name') <> 'Sully';
```

**Why it fails today:** indexing into an array of objects (`X[0].name`) inside a FILTER over a `[User]`/`array_agg(User)` collection needs the array elements to carry full object JSON so `.name` resolves on the element; object-in-collection identity/shape is dropped (`shape_04` is `[(User,)][0]`, `06` is `{ z := ([User],).0 }`, `07` round-trips via `array_agg(array_unpack(Z))`).

### select computable (multi/computed-link-id) (3)

- `test_edgeql_select_computable_31`
- `test_edgeql_select_computable_33`
- `test_edgeql_select_computable_36`

**Representative:** `test_edgeql_select_computable_33`

**EdgeQL:**
```edgeql
SELECT User {name, todo_ids := .todo.id} FILTER .name = 'Elvis';
```

**Relevant ESDL:**
```esdl
type User extending Dictionary { multi todo: Issue { rank: int64 } }
-- todo stored in junction default__user__todo (source=User, target=Issue)
```

**Expected SQL:**
```sql
-- todo_ids is a computed MULTI scalar = the ids of the User's todo Issues.
-- It must aggregate the target ids into a json array, correlated to a0.
SELECT a0."id" AS "id", a0."__source_type" AS "__source_type", a0."name" AS "name",
       COALESCE((SELECT json_group_array(t."id")
                 FROM "default__user__todo" tj
                 JOIN (SELECT "id" FROM "default__issue") t ON t."id" = tj."target"
                 WHERE tj."source" = a0."id"
                 ORDER BY tj."rowid"), '[]') AS "todo_ids"
FROM (SELECT 'default::User' AS "__source_type","id","name" FROM "default__user") a0
WHERE EXISTS (SELECT 1 FROM (SELECT ? AS "value") WHERE "value" = a0."name");
```

**Why it fails today:** a computed multi scalar that projects a *link target's* property (`.todo.id`) inside a shape is not lowered to the correlated `json_group_array` over the junction (`computable_31` is `WITH O := {multi m := 10} SELECT O{m}` — a multi computed over a free binding; `computable_36` is a computed `array<array<int64>>` property `[[1]]`).

### select tvariant (type variant) (3)

- `test_edgeql_select_tvariant_01`
- `test_edgeql_select_tvariant_04`
- `test_edgeql_select_tvariant_05`

**Representative:** `test_edgeql_select_tvariant_01`

**EdgeQL:**
```edgeql
SELECT Issue{
    number,
    related_to: {
        number
    } FILTER Issue.related_to.owner = Issue.owner,
} ORDER BY Issue.number;
```

**Relevant ESDL:**
```esdl
type Issue extending Named, Owned, Text {
    multi related_to: Issue;
    overloaded required link owner { property since: datetime }
}
-- related_to in default__issue__related_to; owner in default__issue__owner.
```

**Expected SQL:**
```sql
-- The nested related_to shape is filtered by comparing the related Issue's owner
-- to the OUTER Issue's owner. The predicate correlates the inner target's owner
-- junction with the outer a0's owner junction.
SELECT a0."id" AS "id", a0."__source_type" AS "__source_type", a0."number" AS "number",
       COALESCE((SELECT json_group_array(json_object('id', r."id",
                    '__source_type', r."__source_type", 'number', r."number"))
          FROM (SELECT 'default::Issue' AS "__source_type","id","number" FROM "default__issue") r
          JOIN "default__issue__related_to" rj ON rj."target" = r."id"
          WHERE rj."source" = a0."id"
            AND (SELECT ro."target" FROM "default__issue__owner" ro WHERE ro."source" = r."id")
              = (SELECT oo."target" FROM "default__issue__owner" oo WHERE oo."source" = a0."id")
          ORDER BY rj."rowid"), '[]') AS "related_to"
FROM (SELECT 'default::Issue' AS "__source_type","id","number" FROM "default__issue") a0
ORDER BY a0."number";
```

**Why it fails today:** the nested shape's FILTER references the *outer* `Issue.owner` (a top-scope path extension) inside the inner correlated subquery; this outer-path correlation in a shape-local FILTER is not threaded (`tvariant_04` builds a `tsl := (.time_spent_log ?? L)` variant then shapes `.tsl{body}`; `tvariant_05` extends `Issue.owner` twice inside nested computed links).

### select tid position (`*` / `**` splat ordering) (3)

- `test_edgeql_select_tid_position_04`
- `test_edgeql_select_tid_position_05`
- `test_edgeql_select_tid_position_06`

**Representative:** `test_edgeql_select_tid_position_05`

**EdgeQL:**
```edgeql
FOR issue IN Issue SELECT issue {
  **,
  lol := 1, sigh := 2,
};
```

**Relevant ESDL:**
```esdl
type Issue extending Named, Owned, Text { ... }   -- ** = deep splat (incl. links)
```

**Expected SQL:**
```sql
-- The ** splat expands every pointer of Issue (and nested objects like owner),
-- but the FIRST key emitted in each object's json_object MUST be the implicit
-- '__tid__' (the type id), before id/property/computed keys.
SELECT json_object(
         '__tid__', a0."__type___id",          -- MUST be first key
         'id', a0."id",
         'name', a0."name", 'body', a0."body", 'number', a0."number",
         -- ... all other Issue pointers (incl. owner sub-object, itself
         --     a json_object whose first key is also '__tid__') ...
         'lol', 1, 'sigh', 2
       ) AS "value"
FROM (SELECT 'default::Issue' AS "__source_type","id","__type___id",
             "name","body","number" FROM "default__issue") a0;
```

**Why it fails today:** the `*`/`**` splat does not place the implicit `__tid__` (type id) as the first pointer key of the emitted object (and of nested splatted objects like `owner`); the test asserts `__dataclass_fields__`' first key is `__tid__` (`tid_position_04` uses `*` + computed `owner` sub-shape, `06` wraps owner in a `FOR ... SELECT owner{*}`).

### free object (DISTINCT / nested) (3)

- `test_edgeql_select_free_object_distinct_02`
- `test_edgeql_select_free_object_distinct_03`
- `test_edgeql_select_card_blowup_01`

**Representative:** `test_edgeql_select_free_object_distinct_02`

**EdgeQL:**
```edgeql
select {
  lol := assert_distinct((for x in {1,2,3} select { x := x }))
};
-- and:
select {
  lol := (for x in {1,2,3} select { x := x })
};
```

**Relevant ESDL:**
```esdl
-- (no schema types; pure free-object / FOR over a scalar set)
```

**Expected SQL:**
```sql
-- Outer free object with one multi computed link `lol`, whose value is a set of
-- 3 free objects { x := x } produced by FOR over {1,2,3}. lol is a json array of
-- those free objects; assert_distinct just passes through (all distinct).
SELECT json_object('lol',
         (SELECT json_group_array(json_object('x', v."value"))
          FROM (SELECT 1 AS "value" UNION ALL SELECT 2 UNION ALL SELECT 3) v)
       ) AS "value";
```

**Why it fails today:** a FOR over a scalar set producing free objects, assigned to a computed link of an outer free object, fails to materialize the inner free-object set (`free_object_distinct_03` errors outright: `Can't compile ref to visible binding ns~1@@(__derived__::x@w~2)` when the FOR result is WITH-bound and re-shaped; `card_blowup_01` is the 8×-duplicated nested `.status{a,b}` cardinality blow-up under `assert_exists`).

### select slice (string/array/json) (2)

- `test_edgeql_select_slice_02`
- `test_edgeql_select_slice_04`

**Representative:** `test_edgeql_select_slice_04`

**EdgeQL:**
```edgeql
select [1,2,3][1:<optional int64>$0];       -- optional upper bound -> {} when arg unset
select to_json('[true, 3, 4, null]')[1:];   -- json array slice
select to_json('"hello world"')[2:];        -- json string slice
select [(1,'foo'), (2,'bar'), (3,'baz')][1:];  -- array-of-tuple slice
```

**Relevant ESDL:**
```esdl
-- (no schema types; literal arrays / json)
```

**Expected SQL:**
```sql
-- Array slice [lo:hi] -> rebuild a json array of the in-range elements via
-- json_each with key bounds; negative indices add length; an optional/empty
-- bound makes the whole slice the empty set (the row is dropped).
SELECT "value" FROM (
  SELECT (SELECT json_group_array(je.value)
          FROM json_each(json_array(1,2,3)) je
          WHERE je.key >= 1
            AND je.key < (CASE WHEN (?) IS NULL THEN NULL
                               WHEN (?) < 0 THEN json_array_length(json_array(1,2,3)) + (?)
                               ELSE (?) END)) AS "value"
)
WHERE "value" IS NOT NULL;   -- optional/empty bound -> no row
-- json string slice uses substr over json_extract($,'$'); to_json('[...]')[1:]
-- re-slices the parsed json array similarly.
```

**Why it fails today:** slicing with negative, optional-param, or empty-set bounds across the three element kinds (str / array / json) mishandles the empty-set / NULL-bound propagation and the json-vs-array element rebuild (`slice_02` slices `.__type__.name` — a string derived from the broken `__type__` projection above).

### singletons (one-off behaviors) (16)

- `test_edgeql_select_recursive_01` — recursive link shape + `related_to *1` depth syntax: `SELECT Issue { number, related_to: { number } }` and `related_to *1`. Expected: correlated json array over `default__issue__related_to`; `*1` caps recursion depth at 1. Fails: the `*N` recursion-depth shape operator isn't lowered.
- `test_edgeql_select_order_03` — `ORDER BY (SELECT sum(<int64>User.<watchers[IS Issue].number))`. Expected: per-User correlated `sum(CAST(number AS INTEGER))` over the watchers-backlink Issues (inspect emits plausible SQL); fails on correlation/cast of the aggregated backlink in ORDER BY position.
- `test_edgeql_select_coalesce_03` — `FILTER Issue.priority.name ?? 'High' = 'High'` with `ORDER BY .priority.name EMPTY LAST THEN .number`. Expected: coalesce of the optional `priority.name` to 'High' inside an existential FILTER + EMPTY LAST ordering of a possibly-empty link path.
- `test_edgeql_partial_03` — nested link shape with computed leaf `name_upper := str_upper(.name)` + shape FILTER `.name = 'Yury'`, outer FILTER on `.status.name`/`.owner.name`. Expected: filtered watchers json array carrying a computed `name_upper` field.
- `test_edgeql_select_if_else_07_b` — `(a IF a.time_estimate < b.time_estimate ELSE b).number` where a,b are object singletons. Expected: choose object branch by scalar condition then read `.number`; inspect emits `SELECT NULL AS "id"` — object-valued IF/ELSE branches collapse to NULL.
- `test_edgeql_select_for_03` — `FOR x IN {1,3,4} UNION (SELECT Issue {...} FILTER .number > <str>x ORDER BY .number LIMIT 2)`. Expected: per-iteration LIMIT 2 applied independently inside the FOR; fails because the LIMIT is not scoped per-FOR-binding (cross join drops the per-x LIMIT).
- `test_edgeql_select_for_04` — `SELECT Issue { asdf := (FOR z IN .due_date UNION (1)) }`. Expected: `asdf` = `{1}` when `.due_date` exists else `{}` — a FOR over an optional property inside a computed shape field.
- `test_edgeql_select_concat_null_01` — `x := [.val] ++ [0]` over BooleanTest where `.val` may be `{}`. Expected: array concat where an empty `.val` makes `[.val]` empty so `x` is `{}` (NULL-element propagation in `[.val]`); inspect builds `json_array(a0."val")` unconditionally (includes a null element instead of dropping the row).
- `test_edgeql_select_scalar_views_01` — nested `WITH` with correlated `count(opt_pair) = count(distinct opt_pair.similarity)` in a FILTER over a scalar `options` set, plus a `Pair` type created at setup. Expected: per-`options`-element correlated double aggregate.
- `test_edgeql_with_rebind_01` — `WITH Z := (SELECT User { name }) SELECT Z` — selecting a WITH-bound shaped set directly must preserve the `{name}` shape on output. Expected: the bound shape's json projection is returned as-is.
- `test_edgeql_select_shadow_computable_01` — `SELECT User := User { name, is_elvis := ... } ORDER BY User.is_elvis`. Expected: ORDER BY the shadowed-binding's computed boolean field; fails resolving `User.is_elvis` (the computed field of the shadowing binding) in ORDER BY.
- `test_edgeql_select_params_array_of_array_01` — `SELECT <array<array<int64>>>$0` (and `$foo`, and a `tuple<array<array<int64>>, array<array<str>>>` param). Expected: nested-collection parameter decode into json; fails decoding array-of-array (and tuple-of-array-of-array) query parameters.
- `test_edgeql_function_source_06` — `SELECT enumerate(array_unpack([(SELECT User FILTER .name[0]='E')]) {name})`. Expected: enumerate over a shaped object set unpacked from an array; pairs `(index, User{name})`.
- `test_edgeql_function_source_07` — `SELECT (enumerate((SELECT User ...)).1 UNION (SELECT User FILTER false)) {name}`. Expected: project `.1` (the User) out of `enumerate`, UNION with empty User set, then shape `{name}`. Fails: extracting the object element `.1` from an `enumerate` tuple and re-shaping it.
- `test_edgeql_function_source_08` — same as 07 but with `??` instead of UNION (`enumerate(...).1 ?? (SELECT User FILTER false)`). Expected: coalesce of the enumerate object element with empty set, then `{name}`.
- `test_edgeql_function_source_09` — same as 07/08 but with `if 1=1 ELSE` (`enumerate(...).1 if 1=1 ELSE (SELECT User FILTER false)`). Expected: object-valued IF/ELSE over the enumerate element, then `{name}`.

**Expected SQL:** (representative — `test_edgeql_function_source_07`, enumerate object-element extraction)
```sql
-- enumerate((SELECT User)).1 is the User object element of each (index, User)
-- pair; .1 must carry full object identity so the trailing {name} shape resolves.
-- UNION with the empty (FILTER false) User set is a no-op; output the shaped json.
SELECT json_object('id', e."id", '__source_type', e."__source_type",
                   'name', e."name") AS "value"
FROM (
    SELECT u."id" AS "id", u."__source_type" AS "__source_type", u."name" AS "name"
    FROM (SELECT 'default::User' AS "__source_type","id","name" FROM "default__user") u
  UNION ALL
    SELECT a1."id", a1."__source_type", a1."name"
    FROM (SELECT 'default::User' AS "__source_type","id","name" FROM "default__user") a1
    WHERE 0
) e;
```

**Why it fails today (group):** these are independent one-off behaviors — `enumerate(...).N` object-element extraction (`function_source_06/07/08/09`), object-valued `IF/ELSE` collapsing to NULL (`if_else_07_b`), per-iteration `LIMIT` inside `FOR` (`for_03`), `FOR` over an optional property in a shape (`for_04`), `*N` recursion depth (`recursive_01`), nested-collection params (`params_array_of_array_01`), shadowed-binding computed field in `ORDER BY` (`shadow_computable_01`), WITH-bound shape passthrough (`with_rebind_01`), `[.val] ++ [0]` empty-element propagation (`concat_null_01`), correlated double-aggregate FILTER (`scalar_views_01`), optional `priority.name ??` in FILTER + EMPTY LAST ordering (`coalesce_03`), filtered computed-leaf link shape (`partial_03`), `sum(<int64>backlink.number)` in ORDER BY (`order_03`).


---

## tests/edgeql_scope.test.ts (77)

| Count | Query group | Pattern |
|---:|---|---|
| 11 | scope ref outer | Computed shape field (often `multi tag :=`) references the OUTER `User`/alias, then re-projected via a WITH-rebound source; correlation to outer `id` must survive rebinding |
| 9 | scope computables | Computed shape field derived from a computable link, or `count`/tuple over two correlated `.owner`/`.deck` paths sharing a common prefix |
| 9 | scope detached | `DETACHED` decorrelates a path → CROSS JOIN of independent copies; explicit reconnection (`F.<friends = User`) re-correlates |
| 6 | scope binding | `WITH`/`FOR`-`UNION` binding reused twice (`(SELECT L), (SELECT L)`) must yield a single shared set, not a fresh cross product |
| 5 | scope filter | `FILTER` in a parallel/sibling scope (or over a `SET OF` arg of `??`/wrapped `SELECT`) must NOT prune the projected set |
| 4 | scope nested | Computed slug/`count` field with a prefix shared between SELECT element and a SET-OF subexpression; nested shape masking a real link name |
| 4 | scope source rebind | `WITH U := (SELECT User { c := ... }), A := (SELECT U FILTER ...)` then read `A.c`/`A {c}` — rebinding `U`→`A` drops the computed/filtered source |
| 4 | scope tuple correlate | Correlated tuple `(User, User.friends)` / `(User{friends}, User.friends)` whose elements must stay zipped when later paths reference `.0`/`.1` |
| 3 | scope sort/limit/offset/order | `ORDER BY`/`OFFSET`/`LIMIT` clause lives in a sibling scope; sort key over a tuple-element object field or computed off the iterating shape |
| 3 | select outer rebind | Inner `WITH U := (select <link> { c := <link>@prop/path })` rebinds the link source then re-projects `U.c`; outer correlation + linkprop must thread through |
| 3 | scope computable factoring | `count(((SELECT U.cards.foo), (SELECT U.cards.foo)))` — repeated factored computable must be one materialized set |
| 3 | semijoin / intersection | `[is Bot].deck`, `Named[IS User].deck`, or filter against `Card.best_award.name` — type-intersection / computed-link semijoin |
| 3 | scope materialized | Materialized FOR-group / free-object set re-read in a later shape or `ORDER BY .keyCard.cost` (issues #6059/#6060) |
| 2 | scope implicit limit | `OFFSET n` with no `LIMIT` on a multi link/top set must apply Gel's implicit-limit clamping semantics |
| 2 | scope schema computed | Schema-level computed link/property (`alter ... create link lcards := ...`) referencing the enclosing object (`User.name[0]`) |
| 2 | scope FOR with computable | `WITH props := (FOR h IN User UNION (select h { namelen := len(h.name) }))` then re-shape `props { name, namelen }` |
| 2 | scope branch | `count((... , ((SELECT User.name) ++ (User.name)).0))` — branch where one operand is wrapped `SELECT` (SET OF) and another is correlated |
| 1 | scope linkprop | `@count` linkprop re-bound through an inner `WITH` and re-projected (`single @count := U.__count`) |
| 1 | scope union | `SELECT {len(User.name), count(User)} FILTER User.name > 'C'` — set/UNION operands are SET OF, FILTER must not apply |

### scope ref outer (11)

- `test_edgeql_scope_ref_outer_01`
- `test_edgeql_scope_ref_outer_02a`
- `test_edgeql_scope_ref_outer_02b`
- `test_edgeql_scope_ref_outer_03`
- `test_edgeql_scope_ref_outer_04`
- `test_edgeql_scope_ref_outer_05a`
- `test_edgeql_scope_ref_outer_05b`
- `test_edgeql_scope_ref_outer_06a`
- `test_edgeql_scope_ref_outer_06b`
- `test_edgeql_scope_ref_outer_07`
- `test_edgeql_scope_ref_outer_09`

**Representative:** `test_edgeql_scope_ref_outer_04`

**EdgeQL:**
```edgeql
WITH
  U := (
    SELECT User {
      cards := .deck {
        name,
        multi tag := User.name ++ " - " ++ .name,
      }
    }),
  A := (SELECT U FILTER .name = 'Alice'),
SELECT _ := A.cards.tag ORDER BY _;
```

**ESDL:**
```esdl
type User extending Named {
    multi deck: Card { count: int64 { default := 1; } ... }
}
type Card extending Named { required name: str; ... }
# Named.name is the required exclusive scalar property
```

**Expected SQL:**
The computed `tag` on each deck Card correlates back to the owning `User` (`a0."name"`),
so dropping the shape into the binding `U` and filtering it to `A` must preserve that
correlation; `A.cards.tag` then flattens the per-card array to a scalar set:
```sql
SELECT "value" AS "value" FROM (
  SELECT ((a0."name" || ?) || a1."name") AS "value"
  FROM (SELECT 'default::User' AS "__source_type", "id", "name" FROM "default__user"
        UNION ALL
        SELECT 'default::Bot' AS "__source_type", "id", "name" FROM "default__bot") a0
  JOIN "default__user__deck" a2 ON a2."source" = a0."id"
  JOIN (SELECT 'default::Card' AS "__source_type", "id", "name" FROM "default__card"
        UNION ALL
        SELECT 'default::SpecialCard' AS "__source_type", "id", "name" FROM "default__specialcard") a1
        ON a1."id" = a2."target"
  WHERE a0."name" IN (?)        -- the A := FILTER .name = 'Alice'
) ORDER BY "value" ASC;
```

**Why it fails today:** Rebinding the shaped source (`U`→`A`) loses the outer-`User`
correlation of the computed `tag`; the inner subquery either errors or reads the wrong
(unfiltered/decorrelated) source. The simple inline form (no `U`/`A` rebind) DOES compile.

### scope computables (9)

- `test_edgeql_scope_computables_01` *(xfail: broke with SIMPLE_SCOPING)*
- `test_edgeql_scope_computables_02`
- `test_edgeql_scope_computables_05`
- `test_edgeql_scope_computables_07a`
- `test_edgeql_scope_computables_07c`
- `test_edgeql_scope_computables_08`
- `test_edgeql_scope_computables_09a`
- `test_edgeql_scope_computables_09b`
- `test_edgeql_scope_computables_11c`

**Representative:** `test_edgeql_scope_computables_08`

**EdgeQL:**
```edgeql
SELECT count((Card.owners.name, Card.owners.deck_cost));
```

**ESDL:**
```esdl
type Card extending Named {
    multi owners := .<deck[IS User];          # computed backlink
}
type User extending Named {
    multi deck: Card { count: int64 ... }
    property deck_cost := sum(.deck.cost);     # computed scalar
}
```

**Expected SQL:**
Both tuple elements share the prefix `Card.owners` (a single correlated `User` set per
Card), so the tuple must zip `name` with the per-owner `deck_cost`, then count the rows:
```sql
SELECT (SELECT count(*) FROM (
  SELECT a1."name" AS "f0",
         (SELECT sum(c."cost")                       -- deck_cost computable
          FROM "default__user__deck" dj JOIN (
            SELECT "id","cost" FROM "default__card"
            UNION ALL SELECT "id","cost" FROM "default__specialcard") c
          ON c."id" = dj."target" WHERE dj."source" = a1."id") AS "f1"
  FROM (SELECT 'default::Card' AS "__source_type","id" FROM "default__card"
        UNION ALL SELECT 'default::SpecialCard' AS "__source_type","id" FROM "default__specialcard") a0
  JOIN "default__user__deck" lj ON lj."target" = a0."id"   -- .<deck[IS User] backlink
  JOIN (SELECT 'default::User' AS "__source_type","id","name" FROM "default__user"
        UNION ALL SELECT 'default::Bot' AS "__source_type","id","name" FROM "default__bot") a1
        ON a1."id" = lj."source"
)) AS "value";
```

**Why it fails today:** `inspect` emits a degenerate `SELECT NULL AS "id"` — a `count`
over a tuple of two paths sharing the `Card.owners` prefix (one of which reaches a
computed `deck_cost`) is not lowered; the shared-prefix correlation is dropped.

### scope detached (9)

- `test_edgeql_scope_detached_01`
- `test_edgeql_scope_detached_02`
- `test_edgeql_scope_detached_03`
- `test_edgeql_scope_detached_04`
- `test_edgeql_scope_detached_05`
- `test_edgeql_scope_detached_06`
- `test_edgeql_scope_detached_09`
- `test_edgeql_scope_detached_11`
- `test_edgeql_scope_detached_14`

**Representative:** `test_edgeql_scope_detached_03`

**EdgeQL:**
```edgeql
WITH
  U0 := DETACHED User.name,
  U1 := DETACHED User.name,
  U2 := DETACHED User.name
SELECT User.name ++ U0 ++ U1 ++ U2;
```

**ESDL:**
```esdl
type User extending Named { ... }   # 4 users: Alice, Bob, Carol, Dave
# Named.name : required str
```

**Expected SQL:**
Each `DETACHED User.name` is an independent copy of the name extent, so the result is a
4-way CROSS JOIN (256 rows). The bare `User.name` is also its own scope here:
```sql
SELECT (((a0."name" || a1."name") || a2."name") || a3."name") AS "value"
FROM (SELECT 'default::User' AS "__source_type","id","name" FROM "default__user"
      UNION ALL SELECT 'default::Bot' AS "__source_type","id","name" FROM "default__bot") a0
CROSS JOIN (... users ...) a1
CROSS JOIN (... users ...) a2
CROSS JOIN (... users ...) a3
WHERE "value" IS NOT NULL;
```

**Why it fails today:** Multiple `DETACHED` copies of the same path must each become a
separate independent CROSS-JOIN operand; the engine collapses/aliases them together
(detached_01's two-copy form lowers, but 3+ copies and the reconnect forms in 04/05 drop
or mis-correlate the detached set).

### scope binding (6)

- `test_edgeql_scope_binding_01`
- `test_edgeql_scope_binding_02a`
- `test_edgeql_scope_binding_02b`
- `test_edgeql_scope_binding_05`
- `test_edgeql_scope_binding_06`
- `test_edgeql_scope_binding_07`

**Representative:** `test_edgeql_scope_binding_01`

**EdgeQL:**
```edgeql
WITH
    L := (FOR name in {'Alice', 'Bob'} UNION (
        SELECT User FILTER .name = name
    )),
SELECT _ := ((SELECT L.name), (SELECT L.name))
ORDER BY _;
```

**ESDL:**
```esdl
type User extending Named { ... }   # name: required str
```

**Expected SQL:**
`L` is a 2-element materialized binding (Alice, Bob users). The tuple `((SELECT L.name),
(SELECT L.name))` is a CROSS JOIN of two independent reads of the SAME binding → 4 rows:
```sql
SELECT "value" FROM (
  SELECT json_array(a0."value", a1."value") AS "value"
  FROM (SELECT u."name" AS "value"
        FROM (SELECT 'Alice' AS name UNION ALL SELECT 'Bob') fv
        JOIN (... users ...) u ON u."name" = fv.name) a0
  CROSS JOIN (SELECT u."name" AS "value"
        FROM (SELECT 'Alice' AS name UNION ALL SELECT 'Bob') fv
        JOIN (... users ...) u ON u."name" = fv.name) a1
) ORDER BY "value" ASC;   -- [Alice,Alice],[Alice,Bob],[Bob,Alice],[Bob,Bob]
```

**Why it fails today:** A `FOR`-`UNION` (or `WITH`) binding referenced twice inside one
tuple must produce a Cartesian product of two independent reads of the same materialized
set; the binding's per-iteration scope is mis-shared (over- or under-correlated).

### scope filter (5)

- `test_edgeql_scope_filter_01`
- `test_edgeql_scope_filter_03`
- `test_edgeql_scope_filter_05`
- `test_edgeql_scope_filter_07`
- `test_edgeql_scope_filter_08`

**Representative:** `test_edgeql_scope_filter_07`

**EdgeQL:**
```edgeql
# User.name is a SET OF argument of ??, so it's unaffected by the FILTER
SELECT (<str>{} ?? User.name)
FILTER User.name = 'Alice';
# expected: {Alice, Bob, Carol, Dave}  -- FILTER does NOT prune
```

**ESDL:**
```esdl
type User extending Named { ... }   # name: required str
```

**Expected SQL:**
`??` makes `User.name` a SET-OF operand, so the `User` mentioned in the FILTER is a
*separate* scope; the filter is existential-but-independent and does not restrict the
projected names. The result is all four names:
```sql
SELECT "value" FROM (
  SELECT COALESCE("lhs", u."name") AS "value"
  FROM (... users ...) u
  LEFT JOIN (SELECT NULL AS "lhs" WHERE 0) e ON 1     -- <str>{} = empty
) WHERE EXISTS (SELECT 1 FROM (... users ...) f WHERE f."name" = ? );  -- independent, always true
-- net effect: every User.name passes through
```

**Why it fails today:** The FILTER's `User` is in a parallel/sibling scope to the
SET-OF `??` operand and must not prune the output set; the engine conflates the two `User`
references and applies the filter to the projection (returning only `Alice`).

### scope nested (4)

- `test_edgeql_scope_nested_01`
- `test_edgeql_scope_nested_06`
- `test_edgeql_scope_nested_11`
- `test_edgeql_scope_nested_12`

**Representative:** `test_edgeql_scope_nested_06`

**EdgeQL:**
```edgeql
# combination of element + SET OF with a common prefix
SELECT (SELECT (
FOR Card in Card
SELECT (Card.name ++ <str>count(Card.owners), Card)
FILTER
    # some element filters
    Card.name < Card.element
    AND
    # a SET OF filter that shares a prefix with SELECT SET OF,
    # but is actually independent
    count(Card.owners.friends) > 2
) ORDER BY .1.name).0;
```

**ESDL:**
```esdl
type Card extending Named {
    required element: str;
    multi owners := .<deck[IS User];   # computed backlink
}
type User extending Named { multi friends: User { nickname: str; } }
```

**Expected SQL:**
`count(Card.owners)` shares the `Card` prefix and is counted per-Card; the FILTER's
`count(Card.owners.friends) > 2` is a SET-OF subexpression that is independent of the
projected tuple but still correlated to the current `Card`, then the outer order/`.0` peels
the first tuple element:
```sql
SELECT json_extract("value", '$[0]') AS "value" FROM (
  SELECT json_array(
      (c."name" || CAST((SELECT count(*) FROM "default__user__deck" oj
                         WHERE oj."target" = c."id") AS TEXT)),
      json_object('id', c."id", '__source_type', c."__source_type")) AS "value"
  FROM (... cards ...) c
  WHERE c."name" < c."element"
    AND (SELECT count(*) FROM "default__user__deck" oj
         JOIN "default__user__friends" fj ON fj."source" = oj."source"
         WHERE oj."target" = c."id") > 2
  ORDER BY json_extract("value", '$[1].name') ASC
);
```

**Why it fails today:** The `count(Card.owners)` / `count(Card.owners.friends)` SET-OF
subexpressions share the `Card` prefix but must each be counted per-row against the current
Card; the engine mis-scopes them (counts the whole extent or drops the correlation), and the
shared-prefix FILTER over the backlink is conflated with the projected count.

### scope source rebind (4)

- `test_edgeql_scope_source_rebind_03a`
- `test_edgeql_scope_source_rebind_03b`
- `test_edgeql_scope_source_rebind_04`
- `test_edgeql_scope_source_rebind_05`

**Representative:** `test_edgeql_scope_source_rebind_03a`

**EdgeQL:**
```edgeql
WITH
  U := (SELECT User {
      cards := (SELECT .deck FILTER random() > 0) }),
  A := (SELECT U FILTER .name = 'Alice')
SELECT A {cards: {name}};
```

**ESDL:**
```esdl
type User extending Named { multi deck: Card { count: int64 ... } }
type Card extending Named { ... }
```

**Expected SQL:**
`cards` is a per-`User` computed (filtered `.deck`); filtering the shaped binding `U` down
to `A` (Alice) and re-projecting `A {cards: {name}}` must keep `cards` correlated to the
filtered Alice row, not to an unfiltered `User`:
```sql
SELECT
  COALESCE((SELECT json_group_array(json_object('name', a1."name"))
     FROM "default__user__deck" a2
     JOIN (... cards ...) a1 ON a1."id" = a2."target"
     WHERE a2."source" = a0."id" AND random() > 0), '[]') AS "cards"
FROM (SELECT a3.* FROM (... users ...) a3
      WHERE a3."name" IN (?)) a0;     -- A := SELECT U FILTER .name = 'Alice'
```

**Why it fails today:** Rebinding `U`→`A` detaches the computed `cards` shape from its
filtered source; `inspect` reads the deck off an *unfiltered* `User` extent (CROSS JOIN with
`A`), so `A.cards` fans out to every user's deck instead of just Alice's.

### scope tuple correlate (4)

- `test_edgeql_scope_tuple_07`
- `test_edgeql_scope_tuple_10`
- `test_edgeql_scope_tuple_correlate_03`
- `test_edgeql_scope_tuple_correlate_04`

**Representative:** `test_edgeql_scope_tuple_correlate_03`

**EdgeQL:**
```edgeql
WITH X := (User, User.friends)
SELECT count(X.0.friends.name ++ X.1.name);
```

**ESDL:**
```esdl
type User extending Named {
    multi friends: User { nickname: str; }
}
```

**Expected SQL:**
`X` zips each `User` with each of its own `friends`; `X.0.friends.name` re-navigates the
first element's friends while `X.1.name` reads the (correlated) second element. The two
must stay distinct:
```sql
SELECT (SELECT count(*) FROM (
  SELECT (ff."name" || x1."name") AS "value"      -- X.0.friends.name ++ X.1.name
  FROM (... users ...) x0                          -- X.0 = User
  JOIN "default__user__friends" j1 ON j1."source" = x0."id"
  JOIN (... users ...) x1 ON x1."id" = j1."target" -- X.1 = User.friends (correlated)
  JOIN "default__user__friends" j2 ON j2."source" = x0."id"
  JOIN (... users ...) ff ON ff."id" = j2."target" -- X.0.friends
)) AS "value";
```

**Why it fails today:** `inspect` collapses both tuple elements to one alias
(`t0."name" || t0."name"`), losing the `(User, User.friends)` correlation — `X.0` and
`X.1` are not kept as distinct, separately-navigable tuple members.

### scope sort/limit/offset/order (3)

- `test_edgeql_scope_order_01`
- `test_edgeql_scope_offset_02`
- `test_edgeql_scope_limit_02`

**Representative:** `test_edgeql_scope_offset_02`

**EdgeQL:**
```edgeql
SELECT User {
    name,
    friends: {
        name
    }  # User.friends is scoped from the enclosing shape
    ORDER BY User.friends.name
    OFFSET (count(User.friends) - 1)
            IF EXISTS User.friends ELSE 0
    # the above is equivalent to getting the last friend, ordered by name
}
ORDER BY User.name;
```

**ESDL:**
```esdl
type User extending Named {
    multi friends: User { nickname: str; }
}
```

**Expected SQL:**
The `friends` shape is ordered by name and offset by `count(User.friends) - 1` (per-row,
correlated to the enclosing `User`); SQLite needs a sentinel `LIMIT -1` to allow a bare
`OFFSET`:
```sql
SELECT a0."id", a0."__source_type", a0."name",
  COALESCE((SELECT json_group_array(json_object(
        'id', a1."id", '__source_type', a1."__source_type", 'name', a1."name"))
     FROM "default__user__friends" a2
     JOIN (... users ...) a1 ON a1."id" = a2."target"
     WHERE a2."source" = a0."id"
     ORDER BY a1."name" ASC
     LIMIT -1 OFFSET (CASE WHEN EXISTS (SELECT 1 FROM "default__user__friends" e
                                        WHERE e."source" = a0."id")
                      THEN ((SELECT count(*) FROM "default__user__friends" e
                             WHERE e."source" = a0."id") - 1)
                      ELSE 0 END)), '[]') AS "friends"
FROM (... users ...) a0
ORDER BY a0."name" ASC;
```

**Why it fails today:** The per-row `OFFSET`/`LIMIT` clause computed off the enclosing
`User.friends` (the `count(...) - 1 IF EXISTS ... ELSE 0` expression in offset_02/limit_02,
the multi-key `assert_single(... @nickname ...) THEN User.name` in order_01) is dropped or
applied with the wrong (decorrelated) friends set, so the wrong slice of friends is returned.

### select outer rebind (3)

- `test_edgeql_select_outer_rebind_04`
- `test_edgeql_select_outer_rebind_05`
- `test_edgeql_select_outer_rebind_06`

**Representative:** `test_edgeql_select_outer_rebind_04`

**EdgeQL:**
```edgeql
select User {
  avatar := (
    with
      U := (
        select User.avatar {
          t := User.avatar@text,
          retag := User.avatar@tag,
        }
      )
    select U {
      name,
      t2 := U.t,
      retag,
    }
  )
} order by .name
```

**ESDL:**
```esdl
type User extending Named {
    avatar: Card {                       # single link WITH linkprops → junction table
        text: str;
        property tag := .name ++ (("-" ++ @text) ?? "");
    }
}
type Card extending Named { ... }
```

**Expected SQL:**
The single `avatar` link carries linkprops, so it lives in junction `default__user__avatar`
(`source`,`target`,`text`,`tag`,`rowid`). The inner `WITH U := select User.avatar { t := @text,
retag := @tag }` rebinds the avatar row of the enclosing `User`; the linkprops must survive
being re-projected as `t`→`t2` and `retag`, and single cardinality is wrapped with
`json_extract(COALESCE(<arr>,'[]'), '$[0]')`:
```sql
SELECT a0."id", a0."__source_type",
  json(COALESCE(json_extract(COALESCE((SELECT json_group_array(json_object(
        'name', a1."name",
        't2', a2."text",                                  -- t2 := U.t := @text
        'retag', a2."tag'))                               -- retag := @tag
     FROM "default__user__avatar" a2
     JOIN (... cards ...) a1 ON a1."id" = a2."target"
     WHERE a2."source" = a0."id" ORDER BY a2."rowid"), '[]'), '$[0]'), 'null')) AS "avatar"
FROM (... users ...) a0
ORDER BY a0."name" ASC;
```

**Why it fails today:** Threading a link-property (`@text`/`@tag`, or the rebound `@count`
in 05/06) through an inner `WITH` rebinding of the link source and out again (as `t`→`t2`)
loses the linkprop column; the re-projected computed reads a nonexistent column / wrong
correlation, or the single-cardinality wrap is dropped.

### scope computable factoring (3)

- `test_edgeql_scope_computable_factoring_01`
- `test_edgeql_scope_computable_factoring_02`
- `test_edgeql_scope_computable_factoring_03`

**Representative:** `test_edgeql_scope_computable_factoring_01`

**EdgeQL:**
```edgeql
WITH U := (
    SELECT User {
        cards := (SELECT .deck { foo := .name })
    } FILTER .name = 'Dave'
)
SELECT count(((SELECT U.cards.foo), (SELECT U.cards.foo)));
```

**ESDL:**
```esdl
type User extending Named { multi deck: Card { count: int64 ... } }
type Card extending Named { ... }   # foo := .name (computed in shape)
```

**Expected SQL:**
`U.cards.foo` is the set of Dave's card names. The tuple reads it twice → a CROSS JOIN of
that set with itself; `count` = (#cards)^2:
```sql
SELECT (SELECT count(*) FROM (
  SELECT json_array(a0."value", a1."value") AS "value"
  FROM (SELECT c."name" AS "value"
        FROM (... users ...) u
        JOIN "default__user__deck" dj ON dj."source" = u."id"
        JOIN (... cards ...) c ON c."id" = dj."target"
        WHERE u."name" = ?) a0           -- Dave's card foos
  CROSS JOIN (SELECT c."name" AS "value" ... WHERE u."name" = ?) a1
)) AS "value";
```

**Why it fails today:** The repeated factored computable `(SELECT U.cards.foo)` must be the
SAME materialized set read twice (a self CROSS JOIN); the engine either materializes it
inconsistently or fails to flatten the `foo` computed through the rebound `U`.

### semijoin / intersection (3)

- `test_edgeql_shape_intersection_semijoin_01`
- `test_edgeql_computable_join_01`
- `test_edgeql_scope_intersection_semijoin_01`

**Representative:** `test_edgeql_scope_intersection_semijoin_01`

**EdgeQL:**
```edgeql
select count(Named[IS User].deck);
```

**ESDL:**
```esdl
abstract type Named { required name: str ... }
type User extending Named { multi deck: Card { ... } }
type Card extending Named { ... }   # Named also has Card, Award, Bot subtypes
```

**Expected SQL:**
`Named[IS User]` intersects the `Named` extent down to `User` (incl. `Bot`); `.deck`
navigates the deck link; `count` totals the deck rows:
```sql
SELECT (SELECT count(*) FROM (
  SELECT a1."id"
  FROM (SELECT "id" FROM "default__user"
        UNION ALL SELECT "id" FROM "default__bot") a0   -- Named[IS User]
  JOIN "default__user__deck" dj ON dj."source" = a0."id"
  JOIN (... cards ...) a1 ON a1."id" = dj."target"
)) AS "value";
```

**Why it fails today:** `inspect` emits a degenerate `SELECT NULL AS "id"` — the type
intersection `Named[IS User]` (narrowing an abstract base extent to a concrete subtype
union before a link hop) is not lowered. The shape variant (`[is Bot].deck` in _01) DOES
emit SQL but uses the wrong junction table and omits the Bot-type gating, so the result is
wrong; `computable_join_01` filters against a computed `best_award` (single computable).

### scope materialized (3)

- `test_edgeql_scope_3x_nested_materialized_02`
- `test_edgeql_scope_mat_issue_6059` *(xerror: Issue #6059)*
- `test_edgeql_scope_mat_issue_6060` *(xerror: Issue #6060)*

**Representative:** `test_edgeql_scope_mat_issue_6060`

**EdgeQL:**
```edgeql
with
  groups := (
    for k in {'Earth', 'Air', 'Fire', 'Water'} union {
      elements := (select Card filter .element = k),
      r := random(),
    }
  ),
  submissions := (groups { minCost := min(.elements.cost) })
select submissions { minCost }
order by .minCost;
```

**ESDL:**
```esdl
type Card extending Named { required element: str; required cost: int64; ... }
```

**Expected SQL:**
The `FOR`-`UNION` produces 4 free objects each holding a materialized `elements` set (and a
volatile `r`); `submissions` re-shapes them with `min(.elements.cost)`, and the outer
SELECT orders by that aggregate. The free-object set must be materialized once and re-read:
```sql
SELECT json_object('minCost', s."minCost") AS "value" FROM (
  SELECT (SELECT min(c."cost")
          FROM (... cards ...) c WHERE c."element" = g.k) AS "minCost"
  FROM (SELECT 'Earth' AS k UNION ALL SELECT 'Air'
        UNION ALL SELECT 'Fire' UNION ALL SELECT 'Water') g
) s
ORDER BY s."minCost" ASC;
```

**Why it fails today:** Issue #6060 (non-group generalization): a materialized
free-object set produced by `FOR ... UNION { ... }` and re-shaped/aggregated in a later
binding is not correctly materialized once and re-read; `materialized_02` is the
`random()`-bearing nested-shape variant.

### scope implicit limit (2)

- `test_edgeql_scope_implicit_limit_01`
- `test_edgeql_scope_implicit_limit_02`

**Representative:** `test_edgeql_scope_implicit_limit_01`

**EdgeQL:**
```edgeql
select User { deck: {name} order by .name offset 3 }
filter .name = 'Carol';
```

**ESDL:**
```esdl
type User extending Named { multi deck: Card { ... } }
type Card extending Named { ... }
```

**Expected SQL:**
`OFFSET 3` with no `LIMIT` on the multi deck link skips the first 3 ordered cards and keeps
the rest; in SQLite a bare OFFSET needs a sentinel `LIMIT -1`:
```sql
SELECT a0."id", a0."__source_type", a0."name",
  COALESCE((SELECT json_group_array(json_object(
        'id', a1."id", '__source_type', a1."__source_type", 'name', a1."name"))
     FROM (... cards ...) a1
     JOIN "default__user__deck" a2 ON a2."target" = a1."id"
     WHERE a2."source" = a0."id"
     ORDER BY a1."name" ASC NULLS LAST LIMIT -1 OFFSET 3), '[]') AS "deck"
FROM (... users ...) a0
WHERE EXISTS (SELECT 1 FROM (SELECT ? AS "value") WHERE "value" = a0."name");
```

**Why it fails today:** Gel applies an *implicit limit* to top-level/multi sets; the
emitted SQL's interaction of `OFFSET` (and the no-LIMIT top-level cases in q1/q2) with that
implicit clamp produces a row count that diverges from the expected result.

### scope schema computed (2)

- `test_edgeql_scope_schema_computed_01`
- `test_edgeql_scope_schema_computed_02`

**Representative:** `test_edgeql_scope_schema_computed_01`

**EdgeQL:**
```edgeql
# DDL:
alter type User
  create link lcards := (select Card filter Card.name[0] = User.name[0]);
# then:
with U := User, select U { name } filter exists .lcards;
# and:
select Bot { lcards: {name} }
```

**ESDL:**
```esdl
type User extending Named { ... }
type Bot extending User;
type Card extending Named { ... }
```

**Expected SQL:**
The schema-level computed link `lcards` resolves per-`User` to Cards whose first letter
matches the user's; `exists .lcards` becomes an existential semijoin, and `Bot` inherits it:
```sql
SELECT a0."id", a0."__source_type", a0."name"
FROM (... users ...) a0
WHERE EXISTS (
  SELECT 1 FROM (... cards ...) c
  WHERE substr(c."name", 1, 1) = substr(a0."name", 1, 1)   -- .name[0] indexing
);
```

**Why it fails today:** A schema-defined computed link/property (added via
`alter type ... create link lcards := ...`) that references the enclosing object
(`User.name[0]`) is not registered/lowered as a per-row correlated computed; inheritance to
`Bot` and the `exists`/shape reads of `.lcards` fail.

### scope FOR with computable (2)

- `test_edgeql_scope_for_with_computable_01`
- `test_edgeql_scope_for_with_computable_02`

**Representative:** `test_edgeql_scope_for_with_computable_01`

**EdgeQL:**
```edgeql
with props := (
  for h in User union (
    select h { namelen := len(h.name) }
  )
)
select props { name, namelen };
```

**ESDL:**
```esdl
type User extending Named { ... }   # name: required str
```

**Expected SQL:**
The `FOR`-`UNION` shapes each `User` with a `namelen` computed; the outer SELECT re-reads
both `name` (stored) and the carried `namelen` computed from the materialized binding:
```sql
SELECT json_object('name', a0."name", 'namelen', length(a0."name")) AS "value"
FROM (... users ...) a0;
```

**Why it fails today:** The computed `namelen` produced inside the `FOR ... UNION` shape is
not carried out to the outer `props { ... }` re-shape — reading the computed off the
materialized FOR-binding drops it (the bare `name` survives but `namelen` is lost / errors).

### scope branch (2)

- `test_edgeql_scope_branch_02`
- `test_edgeql_scope_branch_03`

**Representative:** `test_edgeql_scope_branch_02`

**EdgeQL:**
```edgeql
SELECT count((
    (SELECT User.name),
    ((SELECT User.name) ++ (User.name),).0,
));
```

**ESDL:**
```esdl
type User extending Named { ... }   # 4 users
```

**Expected SQL:**
The first tuple element `(SELECT User.name)` is a SET OF (its own scope, 4 names); the
second wraps `(SELECT User.name) ++ (User.name)` — both operands SET OF, so a 4x4 product —
then takes `.0`. The tuple zips the two branches → count = 4 * 16:
```sql
SELECT (SELECT count(*) FROM (
  SELECT json_array(a0."value", a1."value") AS "value"
  FROM (SELECT u."name" AS "value" FROM (... users ...) u) a0          -- (SELECT User.name)
  CROSS JOIN (SELECT (l."name" || r."name") AS "value"                  -- branch .0
             FROM (... users ...) l CROSS JOIN (... users ...) r) a1
)) AS "value";
```

**Why it fails today:** A tuple branch mixing a wrapped `SELECT` (SET OF, decorrelated) with
a bare `User.name` (correlated within that branch) must compute each branch's product
independently then zip the branches; the engine mis-correlates the branches, giving the
wrong count.

### scope linkprop (1)

- `test_edgeql_scope_linkprop_rebinding_01`

**Representative:** `test_edgeql_scope_linkprop_rebinding_01`

**EdgeQL:**
```edgeql
select assert_exists((WITH
  __user := DETACHED User
SELECT __user {
  deck := (
    WITH
      __user2 := (
        SELECT __user.deck {
          __linkprop_count := __user.deck@count
        }
      )
    SELECT __user2 {
      single @count := __user2.__linkprop_count
    }
  )
} filter .name = 'Alice'));
```

**ESDL:**
```esdl
type User extending Named {
    multi deck: Card {
        count: int64 { default := 1; };   # @count linkprop
    }
}
```

**Expected SQL:**
`@count` reads the `count` column of the `default__user__deck` junction row; the inner
`WITH __user2 := select __user.deck { __linkprop_count := @count }` rebinds the deck link
rows of the enclosing `__user`, then re-emits the linkprop as `single @count :=
__user2.__linkprop_count`:
```sql
SELECT a0."id", a0."__source_type", a0."name",
  COALESCE((SELECT json_group_array(json_object(
        '@count', a2."count"))                            -- @count := __linkprop_count := @count
     FROM "default__user__deck" a2
     JOIN (... cards ...) a1 ON a1."id" = a2."target"
     WHERE a2."source" = a0."id" ORDER BY a2."rowid"), '[]') AS "deck"
FROM (... users ...) a0
WHERE EXISTS (SELECT 1 FROM (SELECT ? AS "value") WHERE "value" = a0."name");
-- + a runtime assert_exists guard that the deck array is non-empty
```

**Why it fails today:** Threading `@count` through an inner `WITH` rebinding of the deck
source and re-projecting it as `single @count := __user2.__linkprop_count` loses the
linkprop column; `inspect` references a phantom `a0."@count"` on the flattened source.

### scope union (1)

- `test_edgeql_scope_union_02`

**Representative:** `test_edgeql_scope_union_02`

**EdgeQL:**
```edgeql
# UNION and {} create SET OF scoped operands, so FILTER should not be effective
SELECT {len(User.name), count(User)}
FILTER User.name > 'C';
# expected: lengths of all four names + 4  (FILTER does NOT prune)
```

**ESDL:**
```esdl
type User extending Named { ... }   # Alice, Bob, Carol, Dave
```

**Expected SQL:**
The set constructor `{ ... }` (a UNION) makes each operand SET OF, so the FILTER's `User`
is an independent scope and does not restrict the projected set — all four name lengths
plus the total count:
```sql
SELECT "value" FROM (
  SELECT length(u."name") AS "value" FROM (... users ...) u   -- len(User.name), all 4
  UNION ALL
  SELECT (SELECT count(*) FROM (... users ...)) AS "value"    -- count(User) = 4
)
WHERE EXISTS (SELECT 1 FROM (... users ...) f WHERE f."name" > ?);  -- independent, always true
```

**Why it fails today:** The `{a, b}` set-constructor operands are SET OF and the trailing
`FILTER User.name > 'C'` is in a sibling scope, so it must not prune the result; the engine
applies the filter to the `len(User.name)` operand, dropping the short-named users.


---

## tests/edgeql_functions_inline.test.ts (74)

These tests define their schema/UDFs inline via `h.script(...)`; there is no `.esdl`. An inline (non-volatile) UDF is **inlined**: its `using (body)` is textually substituted into the call site and the whole thing lowers to one SQL statement. So the "Expected SQL" below is what you'd get by inlining the body into the call, then applying the engine's normal lowering. Aliases use the canonical `a0/a1…` scheme.

| Count | Query group | Pattern |
|---:|---|---|
| 26 | inline UDFs over object sources/returns | UDF takes/returns an object set (incl. `Bar`/`Baz` unions, `[is T]` narrowing, link hops, `count`, tuples) — the object body is spliced into the caller as a correlated object source |
| 14 | inline UDFs with INSERT bodies | `using ((insert …))` — INSERT (incl. nested/multi links, link-props, FOR-iterators, `unless conflict`) spliced into the caller and run per call-site row |
| 13 | inline UDFs inside object/link-property shapes | `select T { c := foo(.x) }` — UDF inlined into a computed shape element, body may itself be an object/`with`/shape |
| 10 | inline UDFs with UPDATE bodies | `using ((update … set {…}))` — UPDATE (incl. multi-link replace, link-prop, FOR-iterators) spliced into the caller |
| 8 | inline scalar/set expansion (set args, variadic, FOR) | scalar UDF whose body is a `FOR … union` / `sum(array_unpack(variadic))` / nested-UDF call — set-of-int expansion |
| 3 | inline UDFs with DELETE/policy bodies | `using ((delete … ).p)` where the deleted type drives `on source/target delete` cascade policies |

### inline UDFs over object sources/returns (26)

- `test_edgeql_functions_inline_object_01`
- `test_edgeql_functions_inline_object_03`
- `test_edgeql_functions_inline_object_05`
- `test_edgeql_functions_inline_object_06`
- `test_edgeql_functions_inline_object_08`
- `test_edgeql_functions_inline_object_09`
- `test_edgeql_functions_inline_object_10`
- `test_edgeql_functions_inline_object_11`
- `test_edgeql_functions_inline_object_12`
- `test_edgeql_functions_inline_object_13`
- `test_edgeql_functions_inline_object_14`
- `test_edgeql_functions_inline_object_15`
- `test_edgeql_functions_inline_object_17`
- `test_edgeql_functions_inline_nested_object_03`
- `test_edgeql_functions_inline_nested_object_04`
- `test_edgeql_functions_inline_nested_object_05`
- `test_edgeql_functions_inline_nested_object_06`
- `test_edgeql_functions_inline_nested_object_07`
- `test_edgeql_functions_inline_nested_object_08`
- `test_edgeql_functions_inline_nested_object_09`
- `test_edgeql_functions_inline_nested_object_10`
- `test_edgeql_functions_inline_nested_object_11`
- `test_edgeql_functions_inline_nested_object_12`
- `test_edgeql_functions_inline_nested_object_13`
- `test_edgeql_functions_inline_nested_object_14`
- `test_edgeql_functions_inline_nested_object_18`

UDFs that take or return an object set are inlined as a correlated object source at the call site. Notable sub-shapes: `object_11/13/14/15` and `nested_object_13/14` take/return a `Bar | Baz` union, with `[is Bar]`/`[is Baz]` narrowing or `if x is Bar`; `object_17` and `nested_object_18` hop through links; `object_08/09` and `nested_object_11/12` build tuples with `count`; `nested_object_*` add one more UDF-call indirection layer that must inline transitively.

**Representative:** `test_edgeql_functions_inline_object_01`

**EdgeQL:**
```edgeql
create type Bar {
    create required property a -> int64;
};
insert Bar{a := 1};
insert Bar{a := 2};
insert Bar{a := 3};
create function foo(x: int64) -> optional Bar {
    using ((select Bar{a} filter .a = x limit 1));
};

# call:
select foo(1).a;
# and with a set arg:
select foo({1, 2, 3}).a;
```

**ESDL:**
```esdl
type Bar { required property a -> int64; }   # table "default__bar" ( "id", "a" )
```

**Expected SQL:** (inline the body `(select Bar{a} filter .a = x limit 1)` for the call `foo(1).a`; the outer `.a` then projects the `a` column of the single resulting object)
```sql
SELECT a1."a" AS "value"
FROM (SELECT ? AS "value") arg
CROSS JOIN LATERAL (
    SELECT 'default::Bar' AS "__source_type", a0."id" AS "id", a0."a" AS "a"
    FROM "default__bar" a0
    WHERE EXISTS (SELECT 1 FROM (SELECT arg."value") WHERE "value" = a0."a")
    LIMIT 1
) a1
```
For the `foo({1,2,3})` call, the `arg` source becomes `(SELECT ? UNION ALL SELECT ? UNION ALL SELECT ?)`, correlated per element (one row per matching `Bar`).

**Why it fails today:** an object-typed UDF body is not spliced as a correlated object source at the call site — the inliner does not substitute the `select Bar … filter .a = x` into the caller while binding `x` to the call argument, so the outer `.a` access / cardinality is lost (object-returning inline UDFs are largely unsupported; passing sibling object tests are the simple `using (x)` / `using (x.a)` identity cases).

### inline UDFs with INSERT bodies (14)

- `test_edgeql_functions_inline_insert_correlate_01`
- `test_edgeql_functions_inline_insert_correlate_03`
- `test_edgeql_functions_inline_insert_correlate_04`
- `test_edgeql_functions_inline_insert_conflict_01`
- `test_edgeql_functions_inline_insert_conflict_02`
- `test_edgeql_functions_inline_insert_link_02`
- `test_edgeql_functions_inline_insert_link_04`
- `test_edgeql_functions_inline_insert_link_iterator_02`
- `test_edgeql_functions_inline_insert_link_iterator_03`
- `test_edgeql_functions_inline_insert_linkprop_01`
- `test_edgeql_functions_inline_insert_linkprop_02`
- `test_edgeql_functions_inline_insert_linkprop_iterator_01`
- `test_edgeql_functions_inline_insert_nested_02`
- `test_edgeql_functions_inline_insert_nested_03`

An INSERT inside a UDF body must be spliced into the caller as a write run per call-site row, then its returned object set consumed by the outer query. Sub-shapes: `correlate_01/03/04` return tuples containing one/two INSERTs; `conflict_01/02` splice `insert … unless conflict … else (update …)`; `insert_link_02` inserts a multi-link (`bar := (select Bar filter .a <= y)`) and reads `.bar.a` off the returned `Baz`; `insert_link_04` uses the UDF result as a link target of an outer INSERT; `link_iterator_02` inserts a multi-link via `FOR … union (insert Bar)`; `link_iterator_03` guards the INSERT with `if flag`; `linkprop_*` set `@b` on the inserted link; `nested_02/03` chain `foo → inner2 → inner1`, each an INSERT.

**Representative:** `test_edgeql_functions_inline_insert_correlate_01`

**EdgeQL:**
```edgeql
create type Bar {
    create required property a -> int64;
};
create function foo(x: int64) -> tuple<Bar, int64> {
    using (((insert Bar{ a := x }), x))
};

# call (runs the insert as a side effect; returns the inserted Bar + x):
for x in {2, 3, 4} union (select foo(x).a);
```

**ESDL:**
```esdl
type Bar { required property a -> int64; }   # table "default__bar" ( "id", "a" )
```

**Expected SQL (spliced INSERT, one per FOR row):** inline `((insert Bar{a := x}), x)`. For each iterator value the body becomes an INSERT whose `a := x` is bound to the call argument, and the tuple's `.0` is the just-inserted `Bar` (whose `.a` the outer query reads):
```sql
-- conceptually, per row x in {2,3,4}:
INSERT INTO "default__bar" ("id", "a") VALUES (<new-uuid>, x)
RETURNING "id" AS "id", "a" AS "a";
-- the caller then selects RETURNING."a" as the tuple element foo(x).a
```
The write is driven row-by-row from the iterator source `(SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4)`; the returned object set is the set of inserted rows.

**Why it fails today:** an INSERT inside a UDF body is not spliced into the caller as a write executed per call-site row — the DML-in-inline-UDF expansion (AST-level `expandInlineDmlFunctionCalls`) does not cover INSERT bodies wrapped in tuples / `unless conflict` / FOR-iterators / multi-link targets / nested UDF calls, so either no row is inserted or the returned object is dropped.

### inline UDFs inside object/link-property shapes (13)

- `test_edgeql_functions_inline_shape_05`
- `test_edgeql_functions_inline_shape_07`
- `test_edgeql_functions_inline_shape_08`
- `test_edgeql_functions_inline_shape_09`
- `test_edgeql_functions_inline_shape_12`
- `test_edgeql_functions_inline_shape_13`
- `test_edgeql_functions_inline_nested_shape_01`
- `test_edgeql_functions_inline_nested_shape_02`
- `test_edgeql_functions_inline_nested_shape_03`
- `test_edgeql_functions_inline_nested_shape_04`
- `test_edgeql_functions_inline_nested_shape_05`
- `test_edgeql_functions_inline_nested_shape_06`
- `test_edgeql_functions_inline_nested_shape_07`

A UDF call inside a computed shape element is inlined and correlated to the shape's subject row. Sub-shapes: `shape_05` returns a multi tuple set; `shape_07/08/09` inline an object/optional/set-of-object body into a computed `c := foo(.b).a`; `shape_12` passes a **multi link** (`a := foo(.bar).a` with `foo(x: Bar) -> Bar using (x)`, producing the per-`Baz` array of `Bar.a`); `shape_13` passes a link-property `.bar@b`; the `nested_shape_*` inline the UDF inside a `with y := select T{… := inner(...)}` then re-project, often with `inner` itself an object/`count`/link-prop UDF.

**Representative:** `test_edgeql_functions_inline_shape_07`

**EdgeQL:**
```edgeql
create type Bar { create required property a -> int64; };
create type Baz {
    create required property a -> int64;
    create required property b -> int64;
};
insert Bar{a := 1}; insert Bar{a := 2}; insert Bar{a := 3};
insert Baz{a := 4, b := 1};
insert Baz{a := 5, b := 2};
insert Baz{a := 6, b := 3};
create function foo(x: int64) -> Bar {
    using (assert_exists((select Bar filter .a = x limit 1)));
};

# call inside a shape:
select Baz{ a, c := foo(.b).a } order by .a;
```

**ESDL:**
```esdl
type Bar { required property a -> int64; }                  # default__bar ( id, a )
type Baz { required property a; required property b; }       # default__baz ( id, a, b )
```

**Expected SQL:** the computed shape element `c := foo(.b).a` inlines to `assert_exists((select Bar filter .a = .b limit 1)).a`, evaluated as a correlated scalar subquery per `Baz` row (`.b` bound to the outer `Baz.b`):
```sql
SELECT a0."a" AS "a",
       (SELECT a1."a"
        FROM "default__bar" a1
        WHERE EXISTS (SELECT 1 FROM (SELECT a0."b" AS "value") WHERE "value" = a1."a")
        LIMIT 1) AS "c"
FROM "default__baz" a0
ORDER BY a0."a"
```
(`assert_exists` adds a "must be exactly one" guard; for `shape_09`'s `set of Bar` body and `shape_12`'s multi-link source the element instead builds a `json_group_array` of the correlated `Bar.a` rows.)

**Why it fails today:** inlining a UDF call inside a computed shape element does not substitute the (object/`count`/link-prop/multi-link) body correlated to the shape's subject row — `.b` / `.bar` / `.bar@b` are not rebound to the function parameter, so the computed column resolves to nothing or errors.

### inline UDFs with UPDATE bodies (10)

- `test_edgeql_functions_inline_update_basic_06`
- `test_edgeql_functions_inline_update_basic_07`
- `test_edgeql_functions_inline_update_iterator_01`
- `test_edgeql_functions_inline_update_iterator_02`
- `test_edgeql_functions_inline_update_iterator_03`
- `test_edgeql_functions_inline_update_link_iterator_01`
- `test_edgeql_functions_inline_update_link_iterator_02`
- `test_edgeql_functions_inline_update_link_iterator_03`
- `test_edgeql_functions_inline_update_linkprop_01`
- `test_edgeql_functions_inline_update_nested_02`

An UPDATE inside an inline UDF body must be spliced as a write driven by the call site. Sub-shapes: `basic_06/07` and `iterator_01` are scalar `set { a := x }` UPDATEs returned as a set, exercised under `for`/`if`/`with`; `iterator_02/03` wrap the UPDATE in a `for z`/`if flag`; `link_iterator_01/02/03` set a link to a single/`for`-inserted/`if`-inserted target; `linkprop_01` updates `@b`; `nested_02` chains `foo → inner2 → inner1` where both inner UDFs are UPDATEs.

**Representative:** `test_edgeql_functions_inline_update_iterator_01`

**EdgeQL:**
```edgeql
create type Bar { create required property a -> int64; };
create function foo(x: int64, y: int64) -> set of int64 {
    using ((update Bar filter .a <= y set { a := x }).a);
};

# call:
select foo(0, 2);          # returns the updated .a set
# and under an iterator:
for x in {1, 2, 3} union (select foo(x - 1, x));
```

**ESDL:**
```esdl
type Bar { required property a -> int64; }   # default__bar ( id, a )
```

**Expected SQL (spliced UPDATE, returning .a):** inline `(update Bar filter .a <= y set {a := x}).a` with `x`,`y` bound to the args:
```sql
UPDATE "default__bar"
SET "a" = ?                       -- x
WHERE EXISTS (SELECT 1 FROM (SELECT ? AS "value")  -- y
              WHERE "a" <= "value")
RETURNING "a" AS "value";
```
Under `for x in {1,2,3}` the UPDATE is executed once per iterator row (binding `x-1`,`x`) and the returned `.a` values are unioned. The outer `select Bar.a` afterwards reads the mutated table.

**Why it fails today:** an UPDATE inside an inline UDF body is not spliced as a write driven by the call site — the inliner does not bind the params into the UPDATE's filter/`set` nor execute it per FOR/`if` iteration, so the table is not mutated (or the returned `.a` set is wrong).

### inline scalar/set expansion (set args, variadic, FOR) (8)

- `test_edgeql_functions_inline_basic_09`
- `test_edgeql_functions_inline_basic_19`
- `test_edgeql_functions_inline_nested_basic_10`
- `test_edgeql_functions_inline_nested_basic_11`
- `test_edgeql_functions_inline_nested_basic_12`
- `test_edgeql_functions_inline_nested_basic_18`
- `test_edgeql_functions_inline_nested_basic_19`
- `test_edgeql_functions_inline_nested_basic_21`

Scalar UDFs whose body is set-valued must thread a (possibly multi) argument into the inlined body element-wise. Sub-shapes: `basic_09` / `nested_basic_10/11/12` use `variadic x: int64` collected into an array then `sum(array_unpack(x))`; `basic_19` / `nested_basic_18/19/21` return `set of int64` via `for y in {x, x+1, x+2} union (…)`; the `nested_*` add a second inlined UDF (`inner`) inside the body.

**Representative:** `test_edgeql_functions_inline_basic_19`

**EdgeQL:**
```edgeql
create function foo(x: int64) -> set of int64 {
    using (for y in {x, x + 1, x + 2} union (y));
};

# calls:
select foo(1);                  # -> {1, 2, 3}
select foo({11, 21, 31});       # set arg: cross-product per element
```

**ESDL:** none (no object types).

**Expected SQL:** inline the body `for y in {x, x+1, x+2} union (y)` with `x` bound to the (possibly multi) argument. For the scalar call `foo(1)`:
```sql
SELECT a0."value" AS "value"
FROM (
    SELECT (?)     AS "value"        -- x
    UNION ALL SELECT (? + 1) AS "value"
    UNION ALL SELECT (? + 2) AS "value"
) a0
```
For the set arg `foo({11,21,31})` the parameter source is `(SELECT 11 UNION ALL SELECT 21 UNION ALL SELECT 31)` and the FOR-union is correlated to each `x` element (9 rows total). The variadic siblings (`basic_09`) instead lower to `sum("value")` over `array_unpack` of the collected args.

**Why it fails today:** inlining a `set of` body (FOR-union / variadic-array) does not correctly bind a multi-valued argument and distribute the body element-wise — the function-parameter set is not threaded into the inlined FOR source, so set-arg / variadic / empty-set cases produce wrong cardinality.

### inline UDFs with DELETE/policy bodies (3)

- `test_edgeql_functions_inline_delete_policy_target_02`
- `test_edgeql_functions_inline_delete_policy_source_02`
- `test_edgeql_functions_inline_delete_policy_source_03`

A DELETE inside an inline UDF body must be spliced as a write that also fires the link `on source/target delete` cascade policy. `target_02`: deleting a `Bar` cascades `on target delete delete source` to its `Baz`; `source_02`: deleting a `Baz` cascades `on source delete delete target` to its `Bar`; `source_03`: same but `delete target if orphan` — only deletes the `Bar` when no other `Baz` still references it.

**Representative:** `test_edgeql_functions_inline_delete_policy_source_02`

**EdgeQL:**
```edgeql
create type Bar { create required property a -> int64; };
create type Baz {
    create required property b -> int64;
    create link bar -> Bar {
        on source delete delete target;
    };
};
create function foo(x: int64) -> set of int64 {
    using ((delete Baz filter .b <= x).b);
};

# call:
select foo(5);    # deletes Baz with b<=5 AND, via policy, their linked Bar
```

**ESDL:**
```esdl
type Bar { required property a -> int64; }            # default__bar ( id, a )
type Baz {
    required property b -> int64;                     # default__baz ( id, b )
    link bar -> Bar { on source delete delete target } # junction default__baz__bar ( source, target, rowid )
}
```

**Expected SQL (spliced DELETE + cascade, returning .b):** inline `(delete Baz filter .b <= x).b`. The primary DELETE selects the matching `Baz` rows; the `on source delete delete target` policy then deletes the linked `Bar` targets (for `source_03`, only those `Bar` with no surviving inbound `bar` link — the `if orphan` guard):
```sql
-- 1) capture victims
WITH victims AS (
    SELECT a0."id" AS "id", a0."b" AS "b"
    FROM "default__baz" a0
    WHERE EXISTS (SELECT 1 FROM (SELECT ? AS "value") WHERE a0."b" <= "value")  -- x
)
-- 2) cascade: delete linked Bar targets
DELETE FROM "default__bar"
WHERE "id" IN (SELECT j."target" FROM "default__baz__bar" j
               WHERE j."source" IN (SELECT "id" FROM victims));
-- (source_03: AND NOT EXISTS another j2.source not in victims pointing at the same target)
-- 3) delete the link rows and the Baz rows
DELETE FROM "default__baz__bar" WHERE "source" IN (SELECT "id" FROM victims);
DELETE FROM "default__baz" WHERE "id" IN (SELECT "id" FROM victims);
-- returns victims."b" as the value set
```

**Why it fails today:** a DELETE inside an inline UDF body is not spliced as a write that also fires the link `on source/target delete` cascade policy — the inliner does not execute the DELETE per call (binding `x`), so neither the `Baz`/`Bar` rows are removed nor the policy-driven cascade (incl. `if orphan`) runs.


---

## tests/edgeql_select_interpreter.test.ts (63)

These mirror `edgeql_select` but exercise the **runtime interpreter** path: constructs
that don't fully lower to a single SQLite statement (free shapes, object-valued
collections, tuples-with-subqueries, set-ops over foreign extents, type-variant
checks). For each group the "Expected SQL" shows the lowerable core; genuinely
interpreter-only / error-expecting cases say so.

| Count | Query group | Pattern |
|---:|---|---|
| 10 | setops | `UNION`/`EXCEPT`/`INTERSECT` over object extents, set-ops in FILTER, `(a UNION b, Issue).0` tuple-of-setop, type-variant in `{...}` union |
| 8 | subqueries (correlated) | common-prefix `Issue`/`Issue2 := Issue` correlation, `EXISTS (SELECT … FILTER … = outer)`, `.number ++ sub` cross |
| 4 | function source (enumerate over subquery) | `enumerate(...).1` / `enumerate(array_unpack([…]){…})` then UNION/`??`/IF + trailing `{name}` shape |
| 4 | cross | scalar cross-product with correlated `count(...)` of a sibling path; `count((Issue, count(...)))` |
| 4 | collection shape | array/tuple literals wrapping object sets — `[(User,)][0]`, `([User],).0`, free-shape over them |
| 4 | expr objects | `array_agg(obj)[i].link.prop`, `array_unpack(array_agg(obj)).link`, object-in-array `IS T` |
| 4 | tvariant bad (variant handling) | `SELECT Issue { priority := Priority }` etc. — type-variant re-point of a pointer; runs `h.script` expecting it to succeed |
| 3 | tvariant | type-variant computed pointer evaluated then re-projected (`}.tsl { body }`, top-scope path extension) |
| 3 | alias indirection | `WITH sub := T{foo:=…}` then reference `sub.foo` / nested computed link off a binding |
| 2 | computable | computed pointer that's a UNION / nested `.todo.id` over a WITH-rebind |
| 2 | for | `FOR x IN {…} UNION (… LIMIT n)` per-iteration cardinality; `FOR z IN .empty UNION (1)` |
| 1 | polymorphic | `SELECT User { [IS Named].id }` — polymorphic shape element collides with auto-id |
| 1 | reverse link (expects error) | `User.<owner[IS Text]@since` — error message text mismatch |
| 1 | order | `ORDER BY (SELECT sum(<int64>User.<watchers[IS Issue].number))` — uncorrelated backlink in ORDER BY |
| 1 | equivalence | `I2 != Issue AND I2.priority.name ?= Issue.priority.name` — `?=` over correlated foreign extent |
| 1 | slice | array/json slice with empty/optional bound and json-string slicing |
| 1 | tuple | nested tuple `(name, (status.name, count(backlink)))` cross-product over backlink |
| 1 | linkproperty | `since := (SELECT .owner)@since` — link-prop off a parenthesized link |
| 1 | if_else (expects error) | `'bar' IF … ELSE 123` — branch type mismatch must raise |
| 1 | partial | `watchers: {…} FILTER .name='Yury'` single-card sub-shape result rendering |
| 1 | banned free shape (expects error) | `DISTINCT {{z:=1},{z:=2}}` / `{z:=1} = {z:=2}` must be rejected |
| 1 | assert fail (expects error) | `array_agg(...)[{1000}].m` — out-of-bounds index must raise |
| 1 | concat null | `x := [.val] ++ [0]` empty-element array NULL propagation |
| 1 | subshape filter | `owner: { name } FILTER false` on a required single link |
| 1 | shadow computable | `SELECT User := User { …, is_elvis := … } ORDER BY User.is_elvis` rebind + order by computed |
| 1 | card blowup | deeply-nested repeated computed sub-shapes (`status1..status8`) cardinality explosion |

### setops (10)

- `test_edgeql_select_interpreter_setops_04`
- `test_edgeql_select_interpreter_setops_10`
- `test_edgeql_select_interpreter_setops_13a`
- `test_edgeql_select_interpreter_setops_13b`
- `test_edgeql_select_interpreter_setops_13c`
- `test_edgeql_select_interpreter_setops_14`
- `test_edgeql_select_interpreter_setops_15`
- `test_edgeql_select_interpreter_setops_24`
- `test_edgeql_select_interpreter_setops_27`
- `test_edgeql_select_interpreter_setops_28`

**Representative:** `test_edgeql_select_interpreter_setops_13a`

**EdgeQL:**
```edgeql
WITH
    L := LogEntry
SELECT
    (Issue.time_spent_log UNION L, Issue).0 {
        body
    };
```

**Relevant ESDL:**
```esdl
type Issue extending Named, Owned, Text {
    multi time_spent_log: LogEntry;
}
type LogEntry extending Owned, Text {
    required spent_time: int64;
}
abstract type Text { required body: str; }
```

**Expected SQL:**
The lowerable core is a UNION-ALL of the two `Text`/`LogEntry` body sources, crossed
with `Issue`, projecting tuple element `.0` (the `LogEntry`) and reading `body`:
```sql
SELECT (SELECT json_object('id', t."id", '__source_type', t."__source_type", 'body', t."body"))
FROM "default__issue" iss
CROSS JOIN (
    SELECT lj."target" AS "id", le."body" AS "body", 'default::LogEntry' AS "__source_type"
      FROM "default__issue__time_spent_log" lj
      JOIN "default__logentry" le ON le."id" = lj."target"
    UNION ALL
    SELECT le2."id", le2."body", 'default::LogEntry' FROM "default__logentry" le2   -- L
) t;
```
(13b wraps the tuple in `SELECT (…)`; 13c inlines `LogEntry` for `L`. 24 = `EXCEPT
{LogEntry, Comment}` / `INTERSECT` over the `Owned` extent. 27/28 = `EXCEPT` /
`INTERSECT` over scalar sets from `str_split`/`len`. 14/15 = type-variant in a
`{Issue{number:='foo'}, Issue}.number` brace-union and run via `h.script`. 10 = a
`(… UNION …).number = '1'` predicate inside FILTER.)

**Why it fails today:** `(setop, Issue).0`-style tuple-of-setop and `EXCEPT`/`INTERSECT`
over object extents emit a stub `SELECT NULL AS "id"` (e.g. setops_24 → `SELECT NULL AS "id", NULL AS "__source_type"`); not lowered, runtime-interpreted.

### subqueries (correlated) (8)

- `test_edgeql_select_interpreter_subqueries_04`
- `test_edgeql_select_interpreter_subqueries_05`
- `test_edgeql_select_interpreter_subqueries_06`
- `test_edgeql_select_interpreter_subqueries_07`
- `test_edgeql_select_interpreter_subqueries_08`
- `test_edgeql_select_interpreter_subqueries_10`
- `test_edgeql_select_interpreter_subqueries_14`
- `test_edgeql_select_interpreter_subqueries_15`

**Representative:** `test_edgeql_select_interpreter_subqueries_05`

**EdgeQL:**
```edgeql
# find all issues such that there's at least one more
# issue with the same priority
WITH
    Issue2 := (SELECT Issue)
SELECT
    Issue { number }
FILTER
    Issue != Issue2
    AND
    Issue.priority = Issue2.priority
ORDER BY
    Issue.number;
```

**Relevant ESDL:**
```esdl
type Issue extending Named, Owned, Text {
    priority: Priority;     # optional single link → inline "priority_id" FK column
}
type Priority extending Dictionary;
```

**Expected SQL:**
`Issue2 := Issue` is an independent extent; the FILTER is an existential over the
cross-product where identities differ and priorities are equal (`=` over single
links is non-empty intersection of target ids):
```sql
SELECT a0."id", 'default::Issue' AS "__source_type", a0."number"
FROM (SELECT * FROM "default__issue") a0
WHERE EXISTS (
    SELECT 1 FROM "default__issue" a1
    WHERE a1."id" <> a0."id"
      AND a0."priority_id" IS NOT NULL
      AND a0."priority_id" = a1."priority_id"
)
ORDER BY a0."number" ASC;
```
(06 = same with `?=` so both-empty also matches → numbers 1,4. 04 = `EXISTS sub`
where `sub` is a WITH binding. 07/08/15 = `EXISTS (SELECT User/Text FILTER User =
Issue.watchers AND User.<watchers != Issue)` self-referential backlink. 10/14 =
`Issue.number ++ sub` cross / `(SELECT Comment FILTER …).owner` over EXISTS.)

**Why it fails today:** the correlated `Issue != Issue2 AND Issue.priority = Issue2.priority`
FILTER is dropped — inspect emits the source `SELECT … FROM "default__issue" a0 ORDER BY a0."number"` with **no WHERE clause** (returns all 4, expected []). Common-prefix / independent-extent correlation in FILTER isn't lowered.

### function source (enumerate over subquery) (4)

- `test_edgeql_function_source_06`
- `test_edgeql_function_source_07`
- `test_edgeql_function_source_08`
- `test_edgeql_function_source_09`

**Representative:** `test_edgeql_function_source_07`

**EdgeQL:**
```edgeql
SELECT (enumerate((
    SELECT User FILTER .name[0] = 'E'
)).1 UNION (SELECT User FILTER false)) {name};
```

**Relevant ESDL:**
```esdl
type User extending Dictionary;          # has required name: str
```

**Expected SQL:**
`enumerate(S)` numbers a set as `(int64, elem)` tuples; `.1` projects the **object
element** back out, unioned with an empty `User`, then a `{name}` shape is applied.
The lowerable core enumerates the filtered `User` rows, takes `.1`, and reads `name`:
```sql
SELECT json_object('id', e."id", 'name', e."name")
FROM (
    SELECT u."id" AS "id", u."name" AS "name"
    FROM (SELECT * FROM "default__user"
          WHERE substr("name", 1, 1) = 'E') u
    UNION ALL
    SELECT u2."id", u2."name" FROM "default__user" u2 WHERE 0   -- (SELECT User FILTER false)
) e;
```
(06 = `enumerate(array_unpack([(SELECT User …)]) {name})` → `[0, {name}]` tuple;
08 = `.1 ?? (SELECT User FILTER false)`; 09 = `.1 if 1=1 ELSE (SELECT User FILTER false)`.)

**Why it fails today:** the `enumerate(...).1` element extraction plus the trailing
object shape are mis-lowered: inspect drops the `{name}` shape (json_object holds only
`'id'`, never `'name'`) and, for the `??` form (08), emits a stub `SELECT NULL AS "id"`
entirely — the tuple-element-of-call + applied shape isn't carried through.

### cross (4)

- `test_edgeql_select_interpreter_cross_04`
- `test_edgeql_select_interpreter_cross08`
- `test_edgeql_select_interpreter_cross_10`
- `test_edgeql_select_interpreter_cross_13`

**Representative:** `test_edgeql_select_interpreter_cross08`

**EdgeQL:**
```edgeql
SELECT _ := Issue.owner.name ++ <str>count(Issue.watchers.name)
ORDER BY _;
```

**Relevant ESDL:**
```esdl
type Issue extending Named, Owned, Text {
    optional multi watchers: User;       # default__issue__watchers junction
}
abstract type Owned { required owner: User; }   # default__issue__owner junction (carries note/since)
```

**Expected SQL:**
For each `Issue`, concat its single owner name with the **per-Issue** count of its
watchers (correlated to the same `Issue` row):
```sql
SELECT (ow."name" || CAST((
    SELECT count(*) FROM "default__issue__watchers" wj WHERE wj."source" = iss."id"
) AS TEXT)) AS "value"
FROM "default__issue" iss
JOIN "default__issue__owner" oj ON oj."source" = iss."id"
JOIN "default__user" ow ON ow."id" = oj."target"
ORDER BY "value" ASC;
```

**Why it fails today:** `count(Issue.watchers.name)` is **decorrelated** — inspect
joins watchers off a fresh `a2` extent (`FROM "default__issue" a2 JOIN
"default__issue__watchers" pj0 ON pj0."source" = a2."id"`) instead of correlating to
the outer `a0` Issue, so every row gets the global count (3) not its own (0/1/1).
cross_04 has the same `.owner.name ++ .<owner[IS Issue].number` correlation issue;
cross_10/cross_13 (`count((Issue, count(...)))`) emit a stub `SELECT NULL AS "id"`.

### collection shape (4)

- `test_edgeql_collection_shape_04`
- `test_edgeql_collection_shape_06`
- `test_edgeql_collection_shape_07`
- `test_edgeql_collection_shape_08`

**Representative:** `test_edgeql_collection_shape_04`

**EdgeQL:**
```edgeql
SELECT [(User,)][0]
```

**Relevant ESDL:**
```esdl
type User extending Dictionary;
```

**Expected SQL:**
A 1-element array of a 1-tuple of an object set; indexing `[0]` yields the tuple
per `User` row. The object element serializes as `{}`/`{id}`:
```sql
SELECT json_array(json_object('id', u."id", '__source_type', u."__source_type"))
FROM "default__user" u;   -- one row per User, each a [(User,)] indexed at 0
```
(06 wraps it in a free shape `{ z := ([User],).0 }`; 07 = `(Z, array_agg(array_unpack(Z))).1`
over `<array<User>>{} IF false ELSE [User]`; 08 = `array_agg(User) FILTER X[0].name != 'Sully'`.)

**Why it fails today:** array/tuple literals that **wrap object sets** emit a stub
`SELECT NULL AS "id", NULL AS "__source_type"` — object-valued collection construction
+ indexing isn't lowered; runtime-interpreted.

### expr objects (4)

- `test_edgeql_select_interpreter_expr_objects_01`
- `test_edgeql_select_interpreter_expr_objects_02`
- `test_edgeql_select_interpreter_expr_objects_04`
- `test_edgeql_select_interpreter_expr_objects_08`

**Representative:** `test_edgeql_select_interpreter_expr_objects_01`

**EdgeQL:**
```edgeql
SELECT array_agg(Issue ORDER BY .body)[0].owner.name;
```

**Relevant ESDL:**
```esdl
type Issue extending Named, Owned, Text { ... }   # owner via default__issue__owner junction
```

**Expected SQL:**
`array_agg` collects all `Issue` objects ordered by body into one array; `[0]`
takes the first; then we hop `.owner.name`:
```sql
SELECT ow."name"
FROM (
    SELECT json_extract(json_group_array(iss."id" ORDER BY iss."body"), '$[0]') AS first_id
    FROM "default__issue" iss
) agg
JOIN "default__issue__owner" oj ON oj."source" = agg.first_id
JOIN "default__user" ow ON ow."id" = oj."target";
```
(02 = `array_unpack(array_agg(Issue)).owner.name`; 04 = `array_agg(Named …)[0] IS Status`
+ tuple of object-array members; 08 = `DISTINCT [(SELECT Issue{number,name} …)]`.)

**Why it fails today:** indexing an `array_agg` of **objects** then hopping a link
emits a stub `SELECT NULL AS "id"` — object-array element link navigation isn't
lowered; runtime-interpreted.

### tvariant bad (variant handling) (4)

- `test_edgeql_select_interpreter_tvariant_bad_05`
- `test_edgeql_select_interpreter_tvariant_bad_06`
- `test_edgeql_select_interpreter_tvariant_bad_07`
- `test_edgeql_select_interpreter_tvariant_bad_08`

**Representative:** `test_edgeql_select_interpreter_tvariant_bad_06`

**EdgeQL:**
```edgeql
SELECT Issue {
    multi owner := User
}
```

**Relevant ESDL:**
```esdl
abstract type Owned { required owner: User; }   # owner is single+required on Issue
type Issue extending Named, Owned, Text { ... }
```

**Expected SQL / expectation:**
Unlike `tvariant_bad_01..04` (which use `.toThrow`), these four just run
`h.script(...)` and are expected to **succeed** — they re-point a pointer in a type
variant: `priority := Priority` (bad_05), `multi owner := User` (bad_06),
`single related_to := (SELECT Issue LIMIT 1)` (bad_07), `owner := (SELECT User LIMIT 1)`
(bad_08). No result is asserted, so any valid plan is acceptable; the expected
lowerable core for bad_06 is a per-Issue shape whose `owner` is the full `User`
extent (a cross/multi rebind):
```sql
SELECT iss."id", 'default::Issue' AS "__source_type",
       (SELECT json_group_array(json_object('id', u."id")) FROM "default__user" u) AS "owner"
FROM "default__issue" iss;
```

**Why it fails today:** type-variant rebinding of an existing single/required link to
`multi`/a different set throws or mis-plans during compile (cardinality/owner
re-derivation on a redefined pointer). Should compile and run.

### tvariant (3)

- `test_edgeql_select_interpreter_tvariant_01`
- `test_edgeql_select_interpreter_tvariant_04`
- `test_edgeql_select_interpreter_tvariant_05`

**Representative:** `test_edgeql_select_interpreter_tvariant_04`

**EdgeQL:**
```edgeql
WITH
    L := LogEntry   # there happens to only be 1 entry
SELECT
    Issue {
        tsl := (Issue.time_spent_log ?? L)
    }.tsl {
        body
    };
```

**Relevant ESDL:**
```esdl
type Issue extending Named, Owned, Text {
    multi time_spent_log: LogEntry;
}
type LogEntry extending Owned, Text { required body: str; }
```

**Expected SQL:**
Build the variant `tsl` (per-Issue `time_spent_log`, coalesced to `L` when empty),
then **re-select** `.tsl` and read `body`. Only Issue 1 has a log; others fall back
to `L`, so every Issue yields a `LogEntry` (here all the same "Rewriting everything."):
```sql
SELECT (SELECT le."body")
FROM "default__issue" iss
JOIN /* tsl = coalesce(time_spent_log, L) */ (
    SELECT tj."source" AS iss_id, tj."target" AS le_id FROM "default__issue__time_spent_log" tj
    UNION ALL  -- L fallback for issues with no log
    SELECT iss2."id", le2."id" FROM "default__issue" iss2, "default__logentry" le2
    WHERE NOT EXISTS (SELECT 1 FROM "default__issue__time_spent_log" t2 WHERE t2."source"=iss2."id")
) tsl ON tsl.iss_id = iss."id"
JOIN "default__logentry" le ON le."id" = tsl.le_id;
```
(01 = `related_to: {number} FILTER Issue.related_to.owner = Issue.owner` correlated
sub-shape FILTER; 05 = top-scope path extension `Issue.owner.<owner[IS Issue]{…}`
inside a computed of `Issue.owner`.)

**Why it fails today:** a type-variant computed pointer (`tsl := …`) that is then
re-projected (`}.tsl { body }`) — the variant's shape doesn't survive the post-projection
hop; runtime-interpreted.

### alias indirection (3)

- `test_edgeql_select_interpreter_alias_indirection_05`
- `test_edgeql_select_interpreter_alias_indirection_10`
- `test_edgeql_select_interpreter_alias_indirection_11`

**Representative:** `test_edgeql_select_interpreter_alias_indirection_10`

**EdgeQL:**
```edgeql
WITH
    sub := (
        SELECT Text { foo := Text.body ++ '!' }
        ORDER BY len(Text.body) ASC
        LIMIT 1
    )
SELECT
    User {
        name,
        shortest_text_foo := sub.foo
    }
FILTER User.name = 'Elvis';
```

**Relevant ESDL:**
```esdl
abstract type Text { required body: str; }    # Comment/Issue/LogEntry are Text
type User extending Dictionary;
```

**Expected SQL:**
`sub` is a single (`LIMIT 1`) `Text` with a computed `foo`; every `User` row gets the
**same** `sub.foo` scalar (the binding is independent of `User`):
```sql
SELECT u."id", 'default::User' AS "__source_type", u."name",
  (SELECT (t."body" || '!')
   FROM (SELECT "body" FROM "default__comment"
         UNION ALL SELECT "body" FROM "default__issue"
         UNION ALL SELECT "body" FROM "default__logentry") t
   ORDER BY length(t."body") ASC LIMIT 1) AS "shortest_text_foo"
FROM "default__user" u
WHERE u."name" = 'Elvis';
```
(05 = `I.owner = U` equality between two WITH bindings; 11 = nested
`open_issues := (SELECT Issue { spent_time := sum(...) } FILTER .owner = User)`
computed link off the `Developers` binding.)

**Why it fails today:** referencing a binding's **computed** member (`sub.foo`) — the
computed-shape on the WITH binding isn't carried through to the path access on
`sub`, so the result differs from expected.

### computable (2)

- `test_edgeql_select_interpreter_computable_33`
- `test_edgeql_select_interpreter_computable_34`

**Representative:** `test_edgeql_select_interpreter_computable_34`

**EdgeQL:**
```edgeql
SELECT Issue{
    number,
    foo := .owner.todo UNION .owner.todo,
}
FILTER Issue.number = '1';
```

**Relevant ESDL:**
```esdl
type User extending Dictionary {
    multi todo: Issue { rank: int64 { default := 42; } }
}
abstract type Owned { required owner: User; }
```

**Expected SQL:**
`foo` is a computed link whose body is a self-UNION of `.owner.todo` (the owner's
todo Issues, doubled). Lowerable core projects the union per Issue:
```sql
SELECT iss."id", 'default::Issue' AS "__source_type", iss."number",
  (SELECT json_group_array(json_object('id', t."target"))
   FROM (
     SELECT tj."target" FROM "default__issue__owner" oj
       JOIN "default__user__todo" tj ON tj."source" = oj."target"
       WHERE oj."source" = iss."id"
     UNION ALL  -- second copy
     SELECT tj2."target" FROM "default__issue__owner" oj2
       JOIN "default__user__todo" tj2 ON tj2."source" = oj2."target"
       WHERE oj2."source" = iss."id"
   ) t) AS "foo"
FROM "default__issue" iss
WHERE iss."number" = '1';
```
(33 = `WITH Z := (SELECT User { asdf := (SELECT .todo ORDER BY .number LIMIT 1)})`
then `Z {name, asdf_id := .asdf.id}` — chained computed link off a WITH-rebind;
inspect drops the inner `asdf` shape so `.asdf.id` resolves wrong.)

**Why it fails today:** a computed link defined as a `UNION` of two link-paths
(34) / a chained computed link off a WITH rebind (33) — the computed pointer's set
body isn't fully lowered; runtime-interpreted.

### for (2)

- `test_edgeql_select_interpreter_for_03`
- `test_edgeql_select_interpreter_for_04`

**Representative:** `test_edgeql_select_interpreter_for_03`

**EdgeQL:**
```edgeql
FOR x IN {1, 3, 4}
UNION (
    SELECT Issue { name, number }
    FILTER Issue.number > <str>x
    ORDER BY Issue.number
    LIMIT 2
);
```

**Relevant ESDL:**
```esdl
type Issue extending Named, Owned, Text { required number: issue_num_t; }
```

**Expected SQL:**
For each `x`, run an **independent** `LIMIT 2` sub-select; the FOR is a UNION-ALL of
the per-iteration bodies (so LIMIT applies per `x`, not globally):
```sql
SELECT json_object('name', s."name", 'number', s."number")
FROM (SELECT 1 AS x UNION ALL SELECT 3 UNION ALL SELECT 4) iter
CROSS JOIN LATERAL (
    SELECT iss."name", iss."number" FROM "default__issue" iss
    WHERE iss."number" > CAST(iter.x AS TEXT)
    ORDER BY iss."number" LIMIT 2
) s;
```

**Why it fails today:** the per-iteration `LIMIT 2` is lost — inspect emits a flat
`(… UNION …) a1 CROSS JOIN "default__issue" a0 WHERE …` with **no per-`x` LIMIT**, so
cardinality is wrong (SQLite has no LATERAL; correlated LIMIT not modeled).
for_04 (`asdf := (FOR z IN .due_date UNION (1))` over an empty `.due_date`) emits a
constant `1 AS "asdf"` unconditionally instead of empty → `null`.

### polymorphic (1)

- `test_edgeql_select_interpreter_polymorphic_04`

**Representative:** `test_edgeql_select_interpreter_polymorphic_04`

**EdgeQL:**
```edgeql
SELECT User {
    [IS Named].id,
};
```

**Relevant ESDL:**
```esdl
abstract type Named { required name: str; }
type User extending Dictionary;     # Dictionary extends Named
```

**Expected SQL:**
A polymorphic shape element selecting `id` only when the row `IS Named` (always true
for `User`):
```sql
SELECT json_object('id', u."id")
FROM "default__user" u;
```

**Why it fails today:** inspect projects **two** `id` columns (`a0."id" AS "id"` plus
the polymorphic `CASE … END AS "id"`), a name collision — the `[IS Named].id` element
is added alongside the implicit id rather than as the sole field; runs via `h.script`.

### reverse link (expects error) (1)

- `test_edgeql_select_interpreter_reverse_link_03`

**Representative:** `test_edgeql_select_interpreter_reverse_link_03`

**EdgeQL:**
```edgeql
SELECT
    User.<owner[IS Text]@since
```

**Relevant ESDL:**
```esdl
abstract type Owned { required owner: User { note: str; } }
type Issue extending ... Owned { overloaded required link owner { property since: datetime; } }
abstract type Text { ... }     # Text has no @since link-prop on owner
```

**Expected SQL / expectation:**
```sql
-- none — must throw at compile time with "property 'since' does not exist"
```

**Why it fails today:** the engine raises the right kind of error but with the **wrong
text**: `E_SEMANTIC: link 'owner' has no property 'since'` (does not match the
expected `property 'since' does not exist`).

### order (1)

- `test_edgeql_select_interpreter_order_03`

**Representative:** `test_edgeql_select_interpreter_order_03`

**EdgeQL:**
```edgeql
SELECT User {name}
ORDER BY (
    SELECT sum(<int64>User.<watchers[IS Issue].number)
);
```

**Relevant ESDL:**
```esdl
type Issue extending ... { optional multi watchers: User; }   # backlink .<watchers[IS Issue]
```

**Expected SQL:**
Order each `User` by the sum of the numbers of Issues that user watches — the
backlink **must be correlated** to the outer `User`:
```sql
SELECT u."id", 'default::User' AS "__source_type", u."name"
FROM "default__user" u
ORDER BY (
    SELECT IFNULL(sum(CAST(iss."number" AS INTEGER)), 0)
    FROM "default__issue__watchers" wj
    JOIN "default__issue" iss ON iss."id" = wj."source"
    WHERE wj."target" = u."id"
) ASC;
```

**Why it fails today:** the ORDER BY sub-select is **decorrelated** — inspect joins
the backlink off a fresh `a2` extent (`FROM "default__user" a2 JOIN
"default__issue__watchers" pj0 …`) with no link back to the outer `a0` User, so the
sort key is the global sum for every row (order undefined).

### equivalence (1)

- `test_edgeql_select_interpreter_equivalence_02`

**Representative:** `test_edgeql_select_interpreter_equivalence_02`

**EdgeQL:**
```edgeql
WITH
    I2 := Issue
SELECT Issue {number}
FILTER
    I2 != Issue
    AND
    I2.priority.name ?= Issue.priority.name
ORDER BY Issue.number;
```

**Relevant ESDL:**
```esdl
type Issue extending ... { priority: Priority; }
type Priority extending Dictionary;   # has name
```

**Expected SQL:**
`?=` treats two empty `priority.name`s as equal, so Issues with no priority (1 and 4)
match each other:
```sql
SELECT a0."id", 'default::Issue' AS "__source_type", a0."number"
FROM "default__issue" a0
WHERE EXISTS (
    SELECT 1 FROM "default__issue" a1
    WHERE a1."id" <> a0."id"
      AND COALESCE((SELECT p1."name" FROM ... WHERE ... = a1."priority_id"), '<∅>')
        = COALESCE((SELECT p0."name" FROM ... WHERE ... = a0."priority_id"), '<∅>')
)
ORDER BY a0."number" ASC;
```

**Why it fails today:** the `I2 != Issue AND … ?= …` correlated-foreign-extent FILTER
with `?=` empty-equivalence over a cross of two `Issue` extents isn't lowered
(same class as subqueries_05/06 correlation); runtime-interpreted.

### slice (1)

- `test_edgeql_select_interpreter_slice_04`

**Representative:** `test_edgeql_select_interpreter_slice_04`

**EdgeQL:**
```edgeql
select [1,2,3,4,5][1:];
-- ... and:
select to_json('"hello world"')[2:];        -- expects "llo world"
select [1,2,3][1:<optional int64>$0];        -- $0 empty → []
select (<optional json>$0)[2:];              -- $0 empty → []
```

**Relevant ESDL:** _(none — pure scalar/collection expressions)_

**Expected SQL:**
Open-ended array slice and json slice; with an empty optional bound the whole slice
is empty:
```sql
-- [1,2,3,4,5][1:]
SELECT (SELECT json_group_array(value) FROM json_each(json_array(1,2,3,4,5)) WHERE key >= 1) AS "value";
-- to_json('"hello world"')[2:]  → substring of a json string
SELECT json_quote(substr(json_extract('"hello world"','$'), 3)) AS "value";
```

**Why it fails today:** mixed bag of slice sub-cases — the json **string** slice
(`to_json('"hello world"')[2:]`) and some open/optional-bound forms don't produce the
expected value (one of the ~12 sub-asserts fails); the array+param forms lower OK.

### tuple (1)

- `test_edgeql_select_interpreter_tuple_02`

**Representative:** `test_edgeql_select_interpreter_tuple_02`

**EdgeQL:**
```edgeql
SELECT
    _ := (
        User.name, (
            User.<owner[IS Issue].status.name,
            count(User.<owner[IS Issue])
        )
    )
ORDER BY _.0 THEN _.1;
```

**Relevant ESDL:**
```esdl
type Issue extending ... Owned { required status: Status; }   # backlink .<owner[IS Issue]
type Status extending Dictionary;
```

**Expected SQL:**
A nested tuple: cross of each `User.name` with the **set** of distinct statuses of
that user's owned issues, paired with the per-user count of owned issues. The inner
`status.name` must fan out (one row per status), `count` stays per-user:
```sql
SELECT json_array(u."name", json_array(st."name", cnt.c))
FROM "default__user" u
JOIN (SELECT oj."target" AS uid, ist."name" AS sname
        FROM "default__issue__owner" oj
        JOIN "default__issue" iss ON iss."id" = oj."source"
        JOIN "default__status" ist ON ist."id" = iss."status_id") st ON st.uid = u."id"
JOIN (SELECT oj2."target" AS uid, count(*) c
        FROM "default__issue__owner" oj2 GROUP BY oj2."target") cnt ON cnt.uid = u."id"
ORDER BY json_extract("value",'$[0]'), json_extract("value",'$[1]');
```

**Why it fails today:** the `count(backlink)` element is correlated to `shr0` (good)
but the nested-tuple cross-product over `status.name` collapses the count incorrectly
(count should be per-(user) but the SQL keeps a single correlated count while the
status fans out) — nested-tuple × set semantics mis-lowered.

### linkproperty (1)

- `test_edgeql_select_interpreter_linkproperty_04`

**Representative:** `test_edgeql_select_interpreter_linkproperty_04`

**EdgeQL:**
```edgeql
SELECT
    Issue { since := (SELECT .owner)@since }
```

**Relevant ESDL:**
```esdl
type Issue extending ... Owned {
    overloaded required link owner { property since: datetime; }
}
```

**Expected SQL:**
`@since` is the link property on `Issue.owner`; reading it off a parenthesized
`(SELECT .owner)` must still resolve to the junction's `since` column:
```sql
SELECT iss."id", 'default::Issue' AS "__source_type",
       oj."since" AS "since"
FROM "default__issue" iss
LEFT JOIN "default__issue__owner" oj ON oj."source" = iss."id";
```

**Why it fails today:** `(SELECT .owner)@since` — the link-property access through a
parenthesized/sub-selected link loses the originating link binding, so `@since`
can't bind to the junction row (run via `h.script`, expected to succeed).

### if_else (expects error) (1)

- `test_edgeql_select_interpreter_if_else_03`

**Representative:** `test_edgeql_select_interpreter_if_else_03`

**EdgeQL:**
```edgeql
SELECT Issue {
    foo := 'bar' IF Issue.number = '1' ELSE 123
};
```

**Relevant ESDL:**
```esdl
type Issue extending Named, Owned, Text { required number: issue_num_t; }
```

**Expected SQL / expectation:**
```sql
-- none — must throw at compile time with a branch-type mismatch (str vs int64) error
```

**Why it fails today:** the engine does not reject `str IF … ELSE int64` — branch
type unification of the conditional expression isn't enforced.

### partial (1)

- `test_edgeql_partial_03`

**Representative:** `test_edgeql_partial_03`

**EdgeQL:**
```edgeql
SELECT Issue {
    number,
    watchers: {
        name,
        name_upper := str_upper(.name)
    } FILTER .name = 'Yury'
} FILTER .status.name = 'Open' AND .owner.name = 'Elvis';
```

**Relevant ESDL:**
```esdl
type Issue extending ... { optional multi watchers: User; required status: Status; }
type User { required name: str; }
```

**Expected SQL:**
Outer filter on correlated `status`/`owner` names; inner `watchers` sub-shape with a
computed `name_upper` and its own FILTER:
```sql
SELECT iss."number",
  (SELECT json_group_array(json_object('name', wu."name", 'name_upper', upper(wu."name")))
   FROM "default__issue__watchers" wj JOIN "default__user" wu ON wu."id" = wj."target"
   WHERE wj."source" = iss."id" AND wu."name" = 'Yury' ORDER BY wj."rowid") AS "watchers"
FROM "default__issue" iss
JOIN "default__issue__status" sj ... JOIN "default__status" st ON st."name" = 'Open'
JOIN "default__issue__owner" oj ... JOIN "default__user" ow ON ow."name" = 'Elvis';
```

**Why it fails today:** the filtered sub-shape `watchers: {…} FILTER .name='Yury'`
combined with the multi-condition outer FILTER produces a mismatched shape/result
(likely the watchers rendering, or the `name_upper` computed inside the filtered sub-shape).

### banned free shape (expects error) (1)

- `test_edgeql_select_interpreter_banned_free_shape_01`

**Representative:** `test_edgeql_select_interpreter_banned_free_shape_01`

**EdgeQL:**
```edgeql
SELECT DISTINCT {{ z := 1 }, { z := 2 }};
-- and:
SELECT DISTINCT { z := 1 } = { z := 2 };
```

**Relevant ESDL:** _(none — free object shapes)_

**Expected SQL / expectation:**
```sql
-- none — must throw at compile time (free shapes have no identity/equality; DISTINCT/= must be rejected)
```

**Why it fails today:** the engine does not ban `DISTINCT`/`=` over free-object
shapes — equality/uniqueness on free shapes isn't rejected.

### assert fail (expects error) (1)

- `test_edgeql_assert_fail_object_computed_02`

**Representative:** `test_edgeql_assert_fail_object_computed_02`

**EdgeQL:**
```edgeql
SELECT array_agg((SELECT User {m := Publication}))[{1000}].m;
```

**Relevant ESDL:**
```esdl
type User extending Dictionary;
type Publication { required title: str; }
```

**Expected SQL / expectation:**
```sql
-- none — must throw at runtime with "array index 1000 is out of bounds"
```

**Why it fails today:** the out-of-bounds object-array index does not raise the
expected error (object-valued `array_agg` indexing + the `{1000}` set index isn't
bounds-checked; this is the object-array path that also stubs in expr_objects).

### concat null (1)

- `test_edgeql_select_interpreter_concat_null_01`

**Representative:** `test_edgeql_select_interpreter_concat_null_01`

**EdgeQL:**
```edgeql
select BooleanTest {
    name,
    val,
    x := [.val] ++ [0]
} order by .name;
```

**Relevant ESDL:**
```esdl
type BooleanTest extending Named { val: int64; multi tags: str; }
```

**Expected SQL:**
When `.val` is empty (`{}`), `[.val]` is an **empty set** (an array literal of an
empty element is empty), so `[.val] ++ [0]` is empty → `x` is `null`; otherwise
`[val, 0]`:
```sql
SELECT bt."name", bt."val",
  CASE WHEN bt."val" IS NULL THEN NULL
       ELSE json_array(bt."val", 0) END AS "x"
FROM "default__booleantest" bt
ORDER BY bt."name" ASC;
```

**Why it fails today:** inspect builds `json_array(a0."val")` unconditionally, so for
NULL `val` it yields `[null]` then `[null,0]` instead of empty/`null` — the
empty-element array (`[<∅>]` → empty set) NULL propagation isn't modeled.

### subshape filter (1)

- `test_edgeql_select_interpreter_subshape_filter_01`

**Representative:** `test_edgeql_select_interpreter_subshape_filter_01`

**EdgeQL:**
```edgeql
SELECT Comment { owner: { name } FILTER false }
```

**Relevant ESDL:**
```esdl
type Comment extending Text, Owned { required issue: Issue; }
abstract type Owned { required owner: User; }   # owner is required single
```

**Expected SQL:**
`owner` is a **required single** link, but `FILTER false` filters it to empty; the
sub-shape becomes an always-empty single object (`null`):
```sql
SELECT c."id", 'default::Comment' AS "__source_type",
  json_extract(COALESCE((
     SELECT json_group_array(json_object('name', ou."name"))
     FROM "default__comment__owner" oj JOIN "default__user" ou ON ou."id" = oj."target"
     WHERE oj."source" = c."id" AND 0   -- FILTER false
  ), '[]'), '$[0]') AS "owner"
FROM "default__comment" c;
```

**Why it fails today:** filtering a **required single** link sub-shape to empty
(`FILTER false`) — the cardinality/required-link handling under an always-false
sub-shape filter mis-plans (run via `h.script`, expected to succeed with empty owner).

### shadow computable (1)

- `test_edgeql_select_interpreter_shadow_computable_01`

**Representative:** `test_edgeql_select_interpreter_shadow_computable_01`

**EdgeQL:**
```edgeql
SELECT User := User { name, is_elvis := User.name = 'Elvis' }
ORDER BY User.is_elvis
```

**Relevant ESDL:**
```esdl
type User extending Dictionary;   # required name: str
```

**Expected SQL:**
`User := User {…}` shadow-rebinds `User` to the shaped variant; the ORDER BY then
references the **computed** `is_elvis` of the rebound set:
```sql
SELECT u."id", 'default::User' AS "__source_type", u."name",
       (u."name" = 'Elvis') AS "is_elvis"
FROM "default__user" u
ORDER BY (u."name" = 'Elvis') ASC;   -- false (Yury) before true (Elvis)
```

**Why it fails today:** ordering by a computed field of a **shadow rebind**
(`User := User {…}` then `ORDER BY User.is_elvis`) — the ORDER BY can't see the
rebound set's computed `is_elvis`; rebind + order-by-computed not threaded.

### card blowup (1)

- `test_edgeql_select_interpreter_card_blowup_01`

**Representative:** `test_edgeql_select_interpreter_card_blowup_01`

**EdgeQL:**
```edgeql
SELECT Comment {
  issue := assert_exists(( .issue {
    status1 := ( .status { a := .__type__.name, b := .__type__.id } ),
    status2 := ( .status { a := .__type__.name, b := .__type__.id } ),
    -- ... status3 .. status8, each the same nested computed sub-shape
  })),
};
```

**Relevant ESDL:**
```esdl
type Comment extending Text, Owned { required issue: Issue; }
type Issue extending ... { required status: Status; }
type Status extending Dictionary;
```

**Expected SQL:**
Each `statusN` is an identical correlated sub-shape reading `.status` with `__type__`
metadata; the 8 copies should each be an independent correlated subquery off the
same `Comment.issue.status`:
```sql
SELECT c."id",
  (SELECT json_object('id', iss."id",
     'status1', (SELECT json_object('a', '...Status', 'b', st_type.id)
                 FROM "default__issue__status" sj JOIN "default__status" st ...),
     'status2', ( ...same... ),
     /* ...status8... */ )
   FROM "default__issue" iss WHERE iss."id" = c."issue_id") AS "issue"
FROM "default__comment" c;
```

**Why it fails today:** 8 repeated nested computed sub-shapes (`status1..status8`,
each with `__type__.name/.id`) blow up the plan — the engine multiplies cardinality
(combinatorial join growth) instead of keeping each sub-shape independent
(run via `h.script`, expected to compile/run without explosion).


---

## tests/edgeql_insert.test.ts (39)

| Count | Query group | Pattern |
|---:|---|---|
| 13 | insert dependent (nested INSERT/FOR/UPDATE writing links) | `INSERT T { link := (INSERT U …) }`, `UPDATE … SET { link := (INSERT …) }`, nested INSERT inside `FOR` |
| 11 | insert unless conflict | `INSERT T {…} UNLESS CONFLICT [ON (.p)] [ELSE (…)]` upsert: conflict probe + INSERT/ELSE branch |
| 5 | insert update cross type conflict | INSERT/UPDATE on sibling types must probe each other for a shared exclusive constraint |
| 3 | DML expression in WITH/SELECT/free-object | INSERT used as a value inside `WITH … SELECT`, `enumerate`, tuple, or a free object |
| 2 | insert cross type conflict | Two INSERTs of related types in one statement colliding on a shared exclusive constraint |
| 2 | insert + access policy | INSERT under an access policy (`deny select`, computed-link global cast) |
| 2 | tuple/collection links & multi-tuple | `multi property tuple<…>` / link-prop assigned from a tuple set via `assert_distinct` |
| 1 | upsert/coalesce with UPDATE ?? INSERT | `(UPDATE …) ?? (INSERT …)` inside `FOR` |

---

### insert dependent (nested INSERT/FOR/UPDATE writing links) (13)

- `test_edgeql_insert_dependent_04`
- `test_edgeql_insert_dependent_05`
- `test_edgeql_insert_dependent_06`
- `test_edgeql_insert_dependent_09`
- `test_edgeql_insert_dependent_14`
- `test_edgeql_insert_dependent_18`
- `test_edgeql_insert_dependent_19`
- `test_edgeql_insert_dependent_20`
- `test_edgeql_insert_dependent_22`
- `test_edgeql_insert_dependent_23`
- `test_edgeql_insert_dependent_24`
- `test_edgeql_insert_dependent_25`
- `test_edgeql_insert_dependent_26`

**Representative:** `test_edgeql_insert_dependent_04`

**EdgeQL:**
```
SELECT (
    INSERT Person {
        name :=  "Zendaya",
        notes := (FOR note in {"hello", "world"}
                  UNION (INSERT Note { name := note }))
    } UNLESS CONFLICT
) { name, notes: {name} ORDER BY .name};
```

**Relevant ESDL:**
```
type Person {
    required single property name -> str { constraint std::exclusive; default := "Nemo"; }
    required single property tag2 -> std::str { default := "<n/a>"; }
    optional multi link notes -> Note;
    optional single link note -> Note;
}
type Note { required property name -> str; property note -> str; link subject -> Object; }
```

**Expected SQL:** (multi-statement DML executed by the engine; the column set is decided at write time)
```
-- 1. iterate the FOR set, inserting one Note per element, capturing ids:
INSERT INTO "default__note" ("id", "name") VALUES (?, ?);   -- 'hello'
INSERT INTO "default__note" ("id", "name") VALUES (?, ?);   -- 'world'

-- 2. insert the parent Person (name is its only assigned scalar; tag2 takes its default):
INSERT INTO "default__person" ("id", "name", "tag2") VALUES (?, 'Zendaya', '<n/a>');

-- 3. link the captured Note ids into the MULTI-link junction:
INSERT INTO "default__person__notes" ("source", "target", "rowid")
    VALUES (?, ?, ?), (?, ?, ?);   -- (personId, helloId), (personId, worldId)

-- read-back for the SELECT shape (multi link → json array via the junction):
-- (SELECT json_group_array(json_object('name', a1."name"))
--    FROM "default__note" a1 JOIN "default__person__notes" a2
--      ON a2."target" = a1."id" WHERE a2."source" = <person>."id" ORDER BY a2."rowid")
```
A **single** link (e.g. `dependent_18`'s `note := (INSERT Note …)`) is stored as an FK column `note_id` on `default__person`, not a junction:
`INSERT INTO "default__person" ("id","name","note_id","tag2") VALUES (?,?,?,?)`.

**Why it fails today:** Nested-INSERT-as-link-value isn't fully wired through the FOR / SELECT-of-INSERT path. Symptoms: `04/05/06/09/14` read back `null`/`0`/`false` (links not persisted or count off); `18/19` emit `no such column: g0.name` (FOR-binding alias for the inner Person unresolved); `20` errors `INSERT assignment for 'tag2' requires SQL lowering` (assigning a nested-INSERT `.name` to a scalar prop); `22/23` over-count Notes (child inserted twice / not deduped on conflict); `24/26` raise `Person2b has no link or property 'name'` (the computed `name := .namespace ++ .last` isn't visible in the INSERT shape read-back); `25` raises `UNLESS CONFLICT argument must be a property of the type being inserted` (conflict on the same computed `name`).

---

### insert unless conflict (11)

- `test_edgeql_insert_unless_conflict_01`
- `test_edgeql_insert_unless_conflict_02`
- `test_edgeql_insert_unless_conflict_04`
- `test_edgeql_insert_unless_conflict_11`
- `test_edgeql_insert_unless_conflict_16`
- `test_edgeql_insert_unless_conflict_17`
- `test_edgeql_insert_unless_conflict_20b`
- `test_edgeql_insert_unless_conflict_25`
- `test_edgeql_insert_unless_conflict_27`
- `test_edgeql_insert_unless_conflict_28`
- `test_edgeql_insert_unless_conflict_self_03`

**Representative:** `test_edgeql_insert_unless_conflict_17`

**EdgeQL:**
```
FOR x IN {"1", "2", "3", "4"} UNION (
    INSERT Person { name := x }
    UNLESS CONFLICT ON (.name)
    ELSE (UPDATE Person SET { tag := "!" })
);
```

**Relevant ESDL:**
```
type Person {
    required single property name -> str { constraint std::exclusive; default := "Nemo"; }
    optional single property tag -> std::str;
    required single property tag2 -> std::str { default := "<n/a>"; }
}
```

**Expected SQL:** (per FOR element: probe the exclusive prop, then INSERT or run the ELSE branch on the conflicting row)
```
-- conflict probe on the exclusive property .name:
SELECT a0."id" FROM "default__person" a0 WHERE a0."name" = ? LIMIT 1;   -- bind x

-- if NO existing row → INSERT:
INSERT INTO "default__person" ("id", "name", "tag2") VALUES (?, ?, '<n/a>');

-- if an existing row WAS found → ELSE branch (UPDATE the conflicting row):
UPDATE "default__person" SET "tag" = '!' WHERE "id" = ?;   -- the probed id
```
The bare `UNLESS CONFLICT` (no `ON`) form (`unless_conflict_28`) must probe **every** exclusive constraint, including a `multi property name` (probe the element-storage table for any overlapping value). `unless_conflict_25` probes an exclusive **link** `.l` (FK column `l_id`).

**Why it fails today:** Several distinct gaps. `01`/`04` are flaky harness equality assertions (`expected undefined to not deeply equal undefined`). `02`/`11` expect specific validation errors (`UNLESS CONFLICT argument must be a property`, `self-referencing INSERTs are not allowed`) that aren't raised. `16` errors `INSERT UNLESS CONFLICT ON does not support volatile properties` (`<str>math::floor(random()*2)` rejected — Gel allows it). `17` UPDATE-in-ELSE inside FOR doesn't apply (`tag` count 1≠2). `20b` parse error `Expected '{' after ':' in link shape` on `sub: Person IS DerivedPerson` in the verify query. `25` raises `missing value for required property 'n'` (nested `INSERT X UNLESS CONFLICT ON (.n) ELSE (X)` as a link value mishandled). `27` raises `missing value for required property 'first'` (nested upsert binding `P` lost). `28` raises `name violates exclusivity constraint` (multi-prop conflict not deduped by the probe). `self_03` does NOT throw — two INSERTs of the same exclusive `name` in one statement (one nested DETACHED) aren't both counted by the exclusivity check.

---

### insert update cross type conflict (5)

- `test_edgeql_insert_update_cross_type_conflict_05b`
- `test_edgeql_insert_update_cross_type_conflict_08a`
- `test_edgeql_insert_update_cross_type_conflict_12`
- `test_edgeql_insert_update_cross_type_conflict_15`
- `test_edgeql_insert_update_cross_type_conflict_17`

**Representative:** `test_edgeql_insert_update_cross_type_conflict_05b`

**EdgeQL:**
```
-- setup: INSERT Person { name := 'Foo' }; INSERT DerivedPerson { name := 'Bar' };
WITH P := Person
UPDATE P FILTER true SET { name := "!" };   -- must raise "name violates exclusivity constraint"
```

**Relevant ESDL:**
```
type Person { required single property name -> str { constraint std::exclusive; ... } }
type DerivedPerson extending Person { property sub_key -> str { constraint exclusive; } }
```

**Expected SQL:** (the UPDATE spans both `Person` and `DerivedPerson`; setting both rows' `name` to `"!"` must be detected as a collision across the sibling tables that share the inherited exclusive `name`)
```
UPDATE "default__person"        SET "name" = '!' WHERE <filter over Person rows>;
UPDATE "default__derivedperson" SET "name" = '!' WHERE <filter over DerivedPerson rows>;

-- cross-type exclusivity check: probe the UNION of all concrete tables under Person
-- for any duplicate "name" and abort if a value appears more than once:
SELECT "name", count(*) AS c FROM (
    SELECT "name" FROM "default__person"
    UNION ALL SELECT "name" FROM "default__derivedperson"
) GROUP BY "name" HAVING c > 1;   -- non-empty → raise "name violates exclusivity constraint"
```

**Why it fails today:** The cross-type exclusivity probe over the type's full concrete-subtype closure isn't run for these shapes, so the expected throw never happens (`expected [Function] to throw an error`). `08a` uses a computed exclusive `name := .namespace ++ .last` on the Person2b closure; `12` a multi-column expression constraint `(__subject__.x + __subject__.y)`; `15` an exclusive prop guarded by an access policy (`deny select` must not hide the conflicting row during the check); `17` must instead raise `do not support exclusive constraints on link properties` for an exclusive `@x` link-prop.

---

### DML expression in WITH/SELECT/free-object (3)

- `test_edgeql_insert_as_expr_01`
- `test_edgeql_insert_enumerate_01`
- `test_edgeql_insert_in_free_object_01`

**Representative:** `test_edgeql_insert_enumerate_01`

**EdgeQL:**
```
WITH
     F := (INSERT Subordinate {name := "!"}),
     B := (INSERT Subordinate {name := "??"}),
     Z := enumerate((F, B)),
SELECT (Z.0, Z.1.0, Z.1.1);
```

**Relevant ESDL:**
```
type Subordinate { required property name -> str; property val -> int64; }
```

**Expected SQL:** (each WITH-bound INSERT runs once and is captured as a single object; then a pure SELECT projects the tuple)
```
INSERT INTO "default__subordinate" ("id", "name") VALUES (?, '!');    -- F
INSERT INTO "default__subordinate" ("id", "name") VALUES (?, '??');   -- B

-- SELECT projects ( enumerate index 0, F-as-object, B-as-object ) as one 3-tuple row:
SELECT 0 AS "0", json_object('id', ?) AS "1", json_object('id', ?) AS "2";
```

**Why it fails today:** `enumerate_01` returns the wrong tuple (`expected false to be true`) — `enumerate` over a tuple of two captured INSERTs doesn't preserve both object bindings into the SELECT tuple. `as_expr_01` errors `FOR requires SQL lowering; runtime fallback disabled` (nested `FOR … UNION (INSERT …)` bound in a `WITH`/`FOR` and re-`UNION`ed into another INSERT). `in_free_object_01` reads back the wrong object count (`expected 2 to be 1`) — an INSERT bound as a free-object field `{ obj := (INSERT …) }` is materialized more than once / re-projected against all rows.

---

### insert cross type conflict (2)

- `test_edgeql_insert_cross_type_conflict_16`
- `test_edgeql_insert_cross_type_conflict_18`

**Representative:** `test_edgeql_insert_cross_type_conflict_16`

**EdgeQL:**
```
-- inline schema: Foo { multi link foo -> Foo; required name -> str { exclusive } }; Bar extending Foo;
WITH name := 'Alice'
INSERT Foo {
    name := name,
    foo := (INSERT Bar { name := name })   -- must raise "name violates exclusivity constraint"
};
```

**Relevant ESDL:** (created inline by the test)
```
type Foo { multi link foo -> Foo; required property name -> str { constraint exclusive }; }
type Bar extending Foo;
```

**Expected SQL:** (nested child INSERT then parent INSERT; the shared inherited exclusive `name` across `Foo`/`Bar` must be probed *before* writing so the duplicate is reported as a Gel constraint error, not a raw SQLite UNIQUE error)
```
-- cross-type pre-check over the Foo closure (Foo ∪ Bar) for the value 'Alice':
SELECT count(*) FROM (
    SELECT "name" FROM "default__foo" UNION ALL SELECT "name" FROM "default__bar"
) WHERE "name" = 'Alice';   -- both inserts use 'Alice' → 2 → raise

INSERT INTO "default__bar" ("id", "name") VALUES (?, 'Alice');   -- child
INSERT INTO "default__foo" ("id", "name") VALUES (?, 'Alice');   -- parent (collision)
```

**Why it fails today:** `16` lets the raw backend error surface (`UNIQUE constraint failed: __gel_excl_…`) instead of the Gel message `name violates exclusivity constraint` — the friendly cross-type pre-check isn't run across the inheritance closure for nested inserts. `18` doesn't throw at all (`expected [Function] to throw an error`) for `SELECT ((insert Foo), (insert Bar))` colliding on a `?? ''` expression constraint shared by `Foo`/`Bar`.

---

### insert + access policy (2)

- `test_edgeql_insert_conflict_policy_02`
- `test_edgeql_insert_policy_cast`

**Representative:** `test_edgeql_insert_conflict_policy_02`

**EdgeQL:**
```
-- alter type Person { create access policy yes allow all using (true);
--                     create access policy no deny select using (true); };
insert Person { name := "test" } unless conflict on (.name) else (Person);
-- a second identical run must raise "violates exclusivity constraint":
-- the `else (Person)` cannot SEE the existing row because `deny select` hides it.
```

**Relevant ESDL:**
```
type Person { required single property name -> str { constraint std::exclusive; ... } }
-- + runtime access policies: `allow all` + `deny select using (true)`
```

**Expected SQL:** (the conflict probe and the ELSE `(Person)` read are subject to `deny select` → they see zero rows → the INSERT proceeds and then hits the exclusive constraint)
```
-- conflict probe wrapped in the access-policy SELECT filter (deny select → WHERE 0):
SELECT a0."id" FROM "default__person" a0 WHERE a0."name" = 'test' AND (0) LIMIT 1;  -- empty
INSERT INTO "default__person" ("id","name","tag2") VALUES (?, 'test', '<n/a>');     -- collides
-- → exclusivity check raises "violates exclusivity constraint"
```

**Why it fails today:** `conflict_policy_02` doesn't raise on the second insert (`expected [Function] to throw an error`) — the `deny select` policy isn't applied to the conflict probe / ELSE read, so the engine "finds" the existing row and silently takes the ELSE branch instead of hitting the constraint. `policy_cast` raises `access policy violation on insert of default::Note` even after the global `sub_id` is set — the policy USING expr `(.subject in global sub) ?? false` with the `<Subordinate>(global sub_id)` cast isn't evaluated correctly (global-cast link comparison).

---

### tuple/collection links & multi-tuple (2)

- `test_edgeql_insert_tuples_04`
- `test_edgeql_insert_collection_04`

**Representative:** `test_edgeql_insert_tuples_04`

**EdgeQL:**
```
with noobs := {
  ((insert Subordinate { name := "foo" }), "bar"),
  ((insert Subordinate { name := "spam" }), "eggs"),
},
select (insert InsertTest {
    l2 := 1,
    subordinates := assert_distinct(noobs.0 { @comment := noobs.1 })
}) { subordinates: {name, @comment} order by .name };
```

**Relevant ESDL:**
```
type InsertTest {
    required property l2 -> int64;
    property l3 -> str { default := "test"; }
    multi link subordinates -> Subordinate { property comment -> str; }
}
type Subordinate { required property name -> str; }
```

**Expected SQL:** (insert the two Subordinates, capture (objectId, comment) pairs from the tuple set, then write the parent and the link rows with the `@comment` link-property column)
```
INSERT INTO "default__subordinate" ("id","name") VALUES (?, 'foo');
INSERT INTO "default__subordinate" ("id","name") VALUES (?, 'spam');
INSERT INTO "default__inserttest" ("id","l2","l3") VALUES (?, 1, 'test');

-- multi-link junction carries the link property "comment":
INSERT INTO "default__inserttest__subordinates" ("source","target","comment","rowid")
    VALUES (?, ?, 'bar', ?), (?, ?, 'eggs', ?);
```

**Why it fails today:** `tuples_04` reads back `0` subordinates (`expected +0 to be 2`) — pairing `noobs.0`/`noobs.1` from the tuple set into link `target` + `@comment` isn't threaded through, so no junction rows are written. `collection_04` reads back `0` for `('bar',1) IN .some_multi_tuple` (`expected +0 to deeply equal 2`) — a `multi property tuple<str,int64>` value set isn't stored/queried correctly (element-wise tuple membership over a multi-property collection).

---

### upsert/coalesce with UPDATE ?? INSERT (1)

- `test_edgeql_insert_coalesce_04`

**Representative:** `test_edgeql_insert_coalesce_04`

**EdgeQL:**
```
select (for n in array_unpack(<array<int64>>$0) union (
    (update InsertTest filter .l2 = n set { name := "!" }) ??
      (insert InsertTest { l2 := n, name := "?" })
)) { l2, name, new := .id not in InsertTest.id } order by .l2
```

**Relevant ESDL:**
```
type InsertTest {
    property name -> str;
    required property l2 -> int64;
    property l3 -> str { default := "test"; }
}
```

**Expected SQL:** (per FOR element `n`: try the UPDATE first; if it matched zero rows, run the INSERT as the `??` fallback)
```
UPDATE "default__inserttest" SET "name" = '!' WHERE "l2" = ? RETURNING "id";   -- bind n
-- if zero rows updated → INSERT fallback:
INSERT INTO "default__inserttest" ("id","l2","name","l3") VALUES (?, ?, '?', 'test');
-- the computed `new := .id not in InsertTest.id` must evaluate against the
-- PRE-statement snapshot of InsertTest.id (true for freshly inserted rows).
```

**Why it fails today:** `coalesce_04` returns `['false']` where `true` expected — `(UPDATE …) ?? (INSERT …)` inside a FOR doesn't fall back to INSERT when the UPDATE is empty, and/or the `new := .id not in InsertTest.id` flag is evaluated against the post-insert set rather than the pre-statement snapshot.




---

## tests/edgeql_linkprops.test.ts (35)

| Count | Query group | Pattern |
|---:|---|---|
| 3 | props back shape | Backlink/computed-backlink `@count` shape that is mis-assembled (complex nested, self-rename, `SpecialCard.owners`) |
| 2 | props back negative | `.<deck { @count }` / `[IS Object]` linkprop reads that should throw "has no property 'count'" |
| 3 | props basic | `@count` used in inner-shape `FILTER`/`ORDER BY`, and `.cost IN .<deck[IS User]@count` |
| 3 | props cross | Correlated `.cost = .<deck[IS User]@count` (path & computed-field positions) |
| 3 | props implication | Boolean implication over backlink `@count` in computed fields / FILTER / shape |
| 5 | props setops | DISTINCT / UNION / tuple / `FILTER` over a linkprop set (`User.deck@count`, `User.friends@nickname`) |
| 4 | props dunder default | `@x := __default__` on a link property in INSERT/UPDATE shapes |
| 3 | props link union | `@x` linkprop read through a `(Bar \| Foo)` union link |
| 2 | props link computed | Reading a *computed* link property (`@total_cost`, `@tag`) as a stored column |
| 2 | props link shadow | Shadowed/aliased `deck := (SELECT User.deck …)` then reading `@count` from it |
| 1 | props computable_02 | WITH-bound ad-hoc computed linkprop `@foo` read in the outer shape |
| 1 | props agg_01 | Per-user `sum(User.deck@count)` inside `FOR User` not correlated |
| 1 | props intersect_01 | `[IS User].deck: { @count }` intersection link over `Named` extent |
| 1 | props modification_01 | Unknown link property `@y` in INSERT must throw "has no property 'y'" |
| 1 | props tuples_01 | Tuple-typed link property `@roles` (`tuple<role1,role2>`) read + field access |

### props back shape (3)

- `test_edgeql_props_back_01`
- `test_edgeql_props_back_09` *(xerror: stack overflow)*
- `test_edgeql_props_schema_back_02`

A backlink (`.<deck[IS User]`) or computed-backlink (`.owners`) shape that surfaces `@count`,
where the surrounding construction is non-trivial: a `for d in .<deck` tuple fed into
`assert_distinct(.z.0 { count := X1.z.1 })` (back_01), a self-rename `@count := @count`
(back_09), or a plain `@count` read off `SpecialCard.owners` (schema_back_02). The simple
renamed/plain forms (back_02/03/05/08, schema_back_03/04/05) now pass.

**Representative:** `test_edgeql_props_schema_back_02`

**EdgeQL:**
```edgeql
-- third sub-assertion of schema_back_02 (the failing one):
select SpecialCard { name, owners: { name, @count }}
filter .name = 'Djinn';
-- expected owners = [{name:'Carol',@count:1}, {name:'Dave',@count:1}]
```

**Relevant ESDL:**
```esdl
type User extending Named { multi deck: Card { count: int64 { default := 1; }; } }
type Bot extending User;
type Card extending Named { multi owners := .<deck[IS User]; }   # computed backlink
type SpecialCard extending Card;
```

**Expected SQL:**
```sql
-- .owners expands to the reverse-deck junction; @count reads default__user__deck."count"
-- (source/target swapped). The SpecialCard extent must still project the owners shape.
SELECT a0."id" AS "id", a0."__source_type" AS "__source_type", a0."name" AS "name",
  COALESCE((SELECT json_group_array(json("item")) FROM (
     SELECT json_object('id', a1."id", '__source_type', a1."__source_type",
                        'name', a1."name", '@count', a2."count") AS "item"
     FROM (SELECT 'default::User' AS "__source_type", "id", "name" FROM "default__user"
           UNION ALL
           SELECT 'default::Bot'  AS "__source_type", "id", "name" FROM "default__bot") a1
     JOIN "default__user__deck" a2 ON a2."source" = a1."id"
     WHERE a2."target" = a0."id"
     ORDER BY a2."rowid")), '[]') AS "owners"
FROM (SELECT 'default::SpecialCard' AS "__source_type", "id", "name" FROM "default__specialcard") a0
WHERE (EXISTS (SELECT 1 FROM (SELECT ? AS "value") WHERE "value" = a0."name"));
```

**Why it fails today:** For `SpecialCard { owners: { @count } }` the `owners` field is dropped from
the projection entirely (inspect emits only `id`/`__source_type`/`name`) — the computed backlink
shape is not assembled for the `SpecialCard` extent. back_01 nests the backlink under
`assert_distinct(.z.0 { count := X1.z.1 })`, where the cross-referenced tuple computed
`X1.z.1` is mis-correlated; back_09 self-renames `@count := @count` (Gel reference: stack overflow).

### props back negative (2)

- `test_edgeql_props_back_06`
- `test_edgeql_props_back_07` *(xfail: too permissive with intersections on supertypes)*

Reading the link property `@count` through a backlink that does NOT resolve to the owning
`User.deck` link — either with no type intersection (`.<deck`) or through `[IS Object]` — must be
rejected, because the `count` property is declared on `User.deck`, not on the bare/supertype link.

**Representative:** `test_edgeql_props_back_06`

**EdgeQL (negative test — must throw):**
```edgeql
select Card { name, z := .<deck { @count }}     -- no [IS User] intersection
filter .name = 'Dragon';
-- back_07 uses .<deck[IS Object] { @count }
```

**Expected SQL:**
```sql
-- none — must throw at compile time with "has no property 'count'"
```

**Why it fails today:** The engine resolves `@count` against the junction even when the backlink is
untyped (back_06) or narrowed only to `Object` (back_07), instead of requiring the concrete
`User.deck` link that declares `count`; so it accepts the query rather than throwing
"has no property 'count'".

### props basic (3)

- `test_edgeql_props_basic_02`
- `test_edgeql_props_basic_03`
- `test_edgeql_props_basic_04`

**Representative:** `test_edgeql_props_basic_02`

**EdgeQL:**
```edgeql
SELECT User {
    name,
    deck: {
        name, element, cost, @count
    } FILTER .cost = @count             -- linkprop in inner-shape FILTER
      ORDER BY @count DESC THEN .name ASC
} ORDER BY .name;
```

**Relevant ESDL:**
```esdl
multi deck: Card { count: int64 { default := 1; }; }   # @count = junction column
```

**Expected SQL:**
```sql
-- inner shape FILTER must compare the target's cost column to the junction count
-- column on the SAME deck row, inside the correlated subquery.
SELECT a0."id", a0."__source_type", a0."name",
  COALESCE((SELECT json_group_array(json("item")) FROM (
     SELECT json_object('id', a1."id", '__source_type', a1."__source_type",
                        'name', a1."name", 'element', a1."element",
                        'cost', a1."cost", '@count', a2."count") AS "item"
     FROM (SELECT 'default::Card' AS "__source_type", "id","name","element","cost" FROM "default__card"
           UNION ALL
           SELECT 'default::SpecialCard' AS "__source_type", "id","name","element","cost" FROM "default__specialcard") a1
     JOIN "default__user__deck" a2 ON a2."target" = a1."id"
     WHERE a2."source" = a0."id"
       AND a1."cost" = a2."count"          -- <-- the inner FILTER .cost = @count
     ORDER BY a2."count" DESC, a1."name" ASC NULLS LAST)), '[]') AS "deck"
FROM (... User UNION Bot ...) a0
ORDER BY a0."name" ASC;
```

**Why it fails today:** The inner-shape `FILTER .cost = @count` is dropped — the subquery emits all
deck rows (test sees 4 cards where 1 is expected). basic_03 has the same root via
`FILTER any((for d in .deck select d.cost = d@count))` at the outer level (4 vs 2 users). basic_04
(`FILTER .cost IN .<deck[IS User]@count`) compiles `.cost IN (?)` against a single param instead of
the backlink `@count` set, so the membership test is wrong.

### props cross (3)

- `test_edgeql_props_cross_01`
- `test_edgeql_props_cross_02`
- `test_edgeql_props_cross_04`

**Representative:** `test_edgeql_props_cross_01`

**EdgeQL:**
```edgeql
SELECT Card { name }
FILTER .cost = .<deck[IS User]@count    -- card cost = its count in SOME deck
ORDER BY .name;
-- expected: Giant turtle, Golem
```

**Relevant ESDL:**
```esdl
multi deck: Card { count: int64 { default := 1; }; }
multi owners := .<deck[IS User];        # backlink used in cross_04
```

**Expected SQL:**
```sql
-- existential: does any reverse-deck junction row for this card have count = cost?
SELECT a0."id", a0."__source_type", a0."name"
FROM (SELECT 'default::Card' AS "__source_type", "id","name","cost" FROM "default__card"
      UNION ALL
      SELECT 'default::SpecialCard' AS "__source_type", "id","name","cost" FROM "default__specialcard") a0
WHERE EXISTS (
    SELECT 1
    FROM "default__user__deck" a2
    WHERE a2."target" = a0."id"
      AND a2."count" = a0."cost"        -- backlink @count = card cost
)
ORDER BY a0."name" ASC;
```

**Why it fails today:** The FILTER lowers to `EXISTS (... WHERE "value" = a0."cost")` against a single
bound `value` — the backlink `@count` junction column is **not** joined into the existential, so the
comparison degenerates and returns 0 rows (expected 2). cross_04 hits `no such column: g0.@count` (the
backlink linkprop is referenced inside an ORDER BY/LIMIT computed field but never projected); cross_02
returns wrong booleans from the `FOR User ... deck@count` cross product (`same` is true/false inverted
for some cards).

### props implication (3)

- `test_edgeql_props_implication_01`
- `test_edgeql_props_implication_02`
- `test_edgeql_props_implication_04`

**Representative:** `test_edgeql_props_implication_02`

**EdgeQL:**
```edgeql
SELECT Card { name }
FILTER NOT (NOT .<deck[IS User]@count = 1 OR .element = 'Fire')
ORDER BY .name;
-- == FILTER (some @count = 1) AND element != 'Fire'  (implication_03, which PASSES)
```

**Relevant ESDL:**
```esdl
multi deck: Card { count: int64 { default := 1; }; }
```

**Expected SQL:**
```sql
-- existential over the reverse-deck junction count column, combined with the
-- element predicate; element-wise EdgeQL "=" => EXISTS form.
SELECT a0."id", a0."__source_type", a0."name"
FROM (... Card UNION SpecialCard ...) a0
WHERE EXISTS (SELECT 1 FROM "default__user__deck" a2
              WHERE a2."target" = a0."id" AND a2."count" = 1)
  AND a0."element" <> 'Fire'
ORDER BY a0."name" ASC;
```

**Why it fails today:** Implication over the backlink `@count` is mis-lowered: implication_02 returns
1 row vs 5 expected (the `NOT(... OR ...)` De Morgan form does not correlate `@count` to the junction).
implication_01 produces a wrong `expr` boolean inside a computed field; implication_04 throws
`[Unsupported:LinkProperty] no such column: p1.@count` (the `expr := NOT User.deck@count = 1 OR ...`
computed field references `@count` in a join alias that lacks the column). Note implication_03, the
refactored AND form, passes — so the OR/NOT shape is the broken path.

### props setops (5)

- `test_edgeql_props_setops_01`
- `test_edgeql_props_setops_02`
- `test_edgeql_props_setops_03`
- `test_edgeql_props_setops_04`
- `test_edgeql_props_setops_05`

**Representative:** `test_edgeql_props_setops_01`

**EdgeQL:**
```edgeql
SELECT DISTINCT User.deck@count;                       -- {1,2,3,4}
SELECT User.deck@count FILTER User.deck.element = 'Fire';   -- bag {1,2,2}
SELECT DISTINCT (
    SELECT User.deck@count FILTER User.deck.element = 'Fire'
);                                                     -- {1,2}
```

**Relevant ESDL:**
```esdl
multi deck: Card { count: int64 { default := 1; }; }   # @count = junction column
multi friends: User { nickname: str; }                 # @nickname (setops_03/04)
```

**Expected SQL:**
```sql
-- the linkprop set is the "count" column of the junction, optionally constrained
-- by an existential FILTER on a sibling path off the SAME deck row.
SELECT DISTINCT "value" AS "value" FROM (
  SELECT pj0."count" AS "value"
  FROM (SELECT 'default::User' AS "__source_type", "id" FROM "default__user"
        UNION ALL
        SELECT 'default::Bot'  AS "__source_type", "id" FROM "default__bot") a0
  JOIN "default__user__deck" pj0 ON pj0."source" = a0."id"
  JOIN (SELECT 'default::Card' AS "__source_type", "id", "element" FROM "default__card"
        UNION ALL
        SELECT 'default::SpecialCard' AS "__source_type", "id", "element" FROM "default__specialcard") c0
    ON c0."id" = pj0."target"
  WHERE pj0."count" IS NOT NULL
    AND c0."element" = 'Fire'        -- FILTER correlates to the same junction row
);
```

**Why it fails today:** The bare `SELECT DISTINCT User.deck@count` compiles fine, but
`FILTER User.deck.element = 'Fire'` on a linkprop projection throws *"reference to
'User.deck.element' changes the interpretation of 'User' elsewhere in the query"* — the FILTER's
sibling path is not correlated to the same `deck` junction row that produced `@count`. setops_02 is a
`deck.name UNION` count mismatch (18 vs 14), setops_03 mis-orders the `friends@nickname` UNION set,
setops_04/05 over-count a `(DISTINCT A.deck@count, A.name)` tuple (4 vs 2 — DISTINCT not applied to the
linkprop column).

### props dunder default (4)

- `test_edgeql_props_dunder_default_01`
- `test_edgeql_props_dunder_default_02`
- `test_edgeql_props_dunder_default_03`
- `test_edgeql_props_dunder_default_04`

**Representative:** `test_edgeql_props_dunder_default_01`

**EdgeQL:**
```edgeql
insert Src {
    n := 1,
    l := assert_single(Tgt { @x := __default__ }),   -- @x defaults to -1
};
insert Src {
    n := 3,
    l := assert_single(Tgt { @x := ( .n ?? __default__ ) }),
};
SELECT Src { n, l: { n, @x } };   -- @x = -1 where __default__ used
```

**Relevant ESDL (script-defined):**
```esdl
CREATE TYPE Tgt { CREATE PROPERTY n -> int64; };
CREATE TYPE Src {
    CREATE PROPERTY n -> int64;
    CREATE LINK l -> Tgt {
        CREATE PROPERTY x -> int64 { set default := -1; };   -- linkprop default
    };
};
-- dunder_default_02/04 add Src2 EXTENDING Src that ALTERs x default := -2
```

**Expected SQL:**
```sql
-- @x := __default__ must resolve to the link-property's declared default (-1),
-- written as the "x" column of the single link junction default__src__l.
INSERT INTO "default__src__l" ("source", "target", "rowid", "x")
VALUES (?, ?, ?, -1);
-- SELECT Src { l: { @x } } then reads that column:
SELECT json_object('@x', a1."x")
FROM "default__src__l" a1 WHERE a1."source" = a0."id";
```

**Why it fails today:** `@x := __default__` throws `[Unsupported:LinkProperty] __default__ cannot be
used in this expression` (dunder_default_01/02). dunder_default_03/04 use
`UPDATE Src set { l := .l { @x := __default__ } }` which throws
`[Unsupported:LinkProperty] no such column: l_id` — the link-update path can't re-resolve the
existing link row to apply the default.

### props link union (3)

- `test_edgeql_props_link_union_01`
- `test_edgeql_props_link_union_02`
- `test_edgeql_props_link_union_03`

**Representative:** `test_edgeql_props_link_union_01`

**EdgeQL (after a CREATE-TYPE script):**
```edgeql
SELECT Baz.fubar.l@x;             -- ["test"]
SELECT Baz.fubar.l[IS Tgt2]@x;    -- ["test"]
SELECT (Foo UNION Bar).l@x;       -- ["test"]
```

**Relevant ESDL (script-defined):**
```esdl
CREATE TYPE Tgt;
CREATE TYPE Tgt2 EXTENDING Tgt;
CREATE TYPE Bar { CREATE LINK l -> Tgt { CREATE PROPERTY x -> str; }; };
CREATE TYPE Foo { CREATE LINK l -> Tgt { CREATE PROPERTY x -> str; }; };
CREATE TYPE Baz { CREATE LINK fubar -> (Bar | Foo); };   -- union-of-types link
```

**Expected SQL:**
```sql
-- fubar is a (Bar|Foo) union link; reaching .l@x must read the "x" linkprop column
-- from whichever owner junction (default__bar__l / default__foo__l) the row lives in,
-- regardless of the concrete target type Tgt2.
SELECT "value" FROM (
  SELECT bj."x" AS "value"
  FROM "default__baz__fubar" fj
  JOIN "default__bar__l" bj ON bj."source" = fj."target"
  WHERE bj."x" IS NOT NULL
  UNION ALL
  SELECT fj2."x" AS "value"
  FROM "default__baz__fubar" fj
  JOIN "default__foo__l" fj2 ON fj2."source" = fj."target"
  WHERE fj2."x" IS NOT NULL
);
```

**Why it fails today:** Throws `[Unsupported:LinkProperty] Unknown field '@x' on 'Tgt2'` — the
linkprop `@x` is looked up on the *target* type (`Tgt2`) instead of on the union-link `l` owned by
`Bar`/`Foo`. union_02/03 differ only in `MULTI` cardinality of `l` and fail identically.

### props link computed (2)

- `test_edgeql_props_link_computed_01`
- `test_edgeql_props_link_computed_02`

**Representative:** `test_edgeql_props_link_computed_01`

**EdgeQL:**
```edgeql
SELECT User {
    name,
    deck: { name, @total_cost } ORDER BY .name
} FILTER .name = 'Alice';
-- @total_cost = @count * .cost  (a COMPUTED link property)
```

**Relevant ESDL:**
```esdl
multi deck: Card {
    count: int64 { default := 1; };
    property total_cost := @count * .cost;     # computed linkprop (NOT stored)
}
avatar: Card {
    text: str;
    property tag := .name ++ (("-" ++ @text) ?? "");   # computed linkprop (computed_02)
}
```

**Expected SQL:**
```sql
-- @total_cost is computed, not a column: lower to @count * target.cost.
SELECT a0."id", a0."__source_type", a0."name",
  COALESCE((SELECT json_group_array(json("item")) FROM (
     SELECT json_object('id', a1."id", '__source_type', a1."__source_type",
                        'name', a1."name",
                        '@total_cost', a2."count" * a1."cost") AS "item"  -- computed
     FROM (... Card UNION SpecialCard ...) a1
     JOIN "default__user__deck" a2 ON a2."target" = a1."id"
     WHERE a2."source" = a0."id"
     ORDER BY a1."name" ASC NULLS LAST)), '[]') AS "deck"
FROM (... User UNION Bot ...) a0
WHERE a0."name" = 'Alice';
```

**Why it fails today:** Throws `[Unsupported:LinkProperty] no such column: j1.total_cost` (and
`j1.tag` for computed_02) — computed link properties are looked up as physical junction columns
instead of being lowered to their defining expression (`@count * .cost`, resp.
`.name ++ (("-" ++ @text) ?? "")`).

### props link shadow (2)

- `test_edgeql_props_link_shadow_01`
- `test_edgeql_props_link_shadow_02`

**Representative:** `test_edgeql_props_link_shadow_02`

**EdgeQL:**
```edgeql
WITH
    AliasedUser := User {
        name,
        deck := (SELECT User.deck ORDER BY .name LIMIT 2)   -- shadow the deck link
    }
SELECT AliasedUser {
    name,
    deck: { @count }                 -- read linkprop off the SHADOWED deck
} ORDER BY .name;
```

**Relevant ESDL:**
```esdl
multi deck: Card { count: int64 { default := 1; }; }
```

**Expected SQL:**
```sql
-- the shadowed deck still maps to the same junction; @count must survive the
-- ORDER BY .name LIMIT 2 reshaping and be read per surviving deck row.
SELECT a0."id", a0."__source_type", a0."name",
  COALESCE((SELECT json_group_array(json("item")) FROM (
     SELECT json_object('@count', a2."count") AS "item"
     FROM (... Card UNION SpecialCard ...) a1
     JOIN "default__user__deck" a2 ON a2."target" = a1."id"
     WHERE a2."source" = a0."id"
     ORDER BY a1."name" ASC NULLS LAST
     LIMIT 2)), '[]') AS "deck"
FROM (... User UNION Bot ...) a0
ORDER BY a0."name" ASC;
```

**Why it fails today:** shadow_02 returns 4 deck rows instead of the `LIMIT 2`-bounded 2 — the
`LIMIT`/`ORDER BY` on the shadowed `deck := (SELECT User.deck …)` is dropped when the linkprop
`@count` is later read off it. shadow_01 reshapes the same shadowed deck (`{ name }` only) and the
per-user `LIMIT 2` ordering is wrong (mismatched object set).

### props computable_02 (1)

- `test_edgeql_props_computable_02`

**EdgeQL:**
```edgeql
WITH MyUser := (
    SELECT User { my_deck := (SELECT Card { @foo := Card.name }
                              FILTER .name = 'Djinn') }
    FILTER User.name = 'Alice'
)
SELECT MyUser { name, my_deck: { @foo } };
-- expected my_deck.@foo = 'Djinn'
```

**Relevant ESDL:** `my_deck` is an ad-hoc computed link; `@foo := Card.name` is a *computed* linkprop
on it (not from the schema). The non-WITH form (computable_01) passes.

**Expected SQL:** `@foo` should carry the inner `Card.name` value (`'Djinn'`) through the WITH binding
into the outer `my_deck: { @foo }` shape — a correlated subquery selecting
`json_object('@foo', a1."name")` for the single matching Card.

**Why it fails today:** Outer read of `@foo` off the WITH-bound computed link returns 0 rows
(`expected +0 to be 1`) — the ad-hoc computed linkprop defined in the binding is not propagated to
the outer shape projection.

### props agg_01 (1)

- `test_edgeql_props_agg_01`

**EdgeQL:**
```edgeql
SELECT sum(User.deck@count);                  -- 51 (PASSES)
SELECT _ := (FOR User in User
             SELECT (sum(User.deck@count), User.name))
ORDER BY _;                                   -- per-user sums: [10,Alice],[12,Bob],...
```

**Relevant ESDL:** `multi deck: Card { count: int64 { default := 1; }; }`

**Expected SQL:**
```sql
-- per-user aggregate: sum the junction "count" column grouped by the FOR user row.
SELECT json_array(
   (SELECT IFNULL(sum(pj0."count"),0)
    FROM "default__user__deck" pj0 WHERE pj0."source" = u."id"),
   u."name")
FROM (... User UNION Bot ...) u
ORDER BY ...;
```

**Why it fails today:** The global `sum(User.deck@count)` = 51 is correct, but inside
`FOR User IN User SELECT (sum(User.deck@count), User.name)` the sum is **not** correlated to the
per-iteration user — it returns the global 51 for every row (`expected 51 to deeply equal 10`).

### props intersect_01 (1)

- `test_edgeql_props_intersect_01`

**EdgeQL:**
```edgeql
select Named {
   [IS User].deck: { name, @count }      -- type-intersection link with linkprop
} filter .name = 'Alice';
```

**Relevant ESDL:**
```esdl
abstract type Named { required name: str { delegated constraint exclusive; } }
type User extending Named { multi deck: Card { count: int64 { default := 1; }; } }
```

**Expected SQL:** Over `Named`, narrow to the `User` branch (`__source_type = 'default::User'`/`Bot`),
then read `deck` via `default__user__deck` with `@count = a2."count"` per deck row; non-User Named
rows contribute no `deck`.

**Why it fails today:** The `[IS User].deck: { @count }` intersection shape over the `Named` supertype
produces a mismatched object set (`expected false to be true`) — the type-narrowed link + its `@count`
is not assembled correctly for the polymorphic `Named` extent.

### props modification_01 (1)

- `test_edgeql_props_modification_01`

**EdgeQL (negative test — must throw):**
```edgeql
insert Src { l := assert_single(Tgt { @y := "..." }) };
-- expected: throw "link 'l' of object type 'default::Src' has no property 'y'"
```

**Relevant ESDL (script-defined):**
```esdl
CREATE TYPE Tgt;
CREATE TYPE Src { CREATE LINK l -> Tgt { CREATE PROPERTY x -> str; }; };  -- only @x exists
```

**Expected SQL:**
```sql
-- none — must throw at compile time with "has no property 'y'"
```

**Why it fails today:** The engine does **not** throw (`expected [Function] to throw an error`) — an
unknown link property `@y` on link `l` is silently accepted instead of being validated against `l`'s
declared properties.

### props tuples_01 (1)

- `test_edgeql_props_tuples_01`

**EdgeQL:**
```edgeql
insert Foo { orgs := (select Org {
    @roles := (role1 := true, role2 := false) }) };
select Foo.orgs@roles.role1;   -- expected: true
```

**Relevant ESDL (script-defined):**
```esdl
create type Org;
create type Foo {
    create multi link orgs -> Org {
        create property roles -> tuple<role1: bool, role2: bool>;   -- tuple linkprop
    }
};
```

**Expected SQL:** `@roles` is a `tuple<role1,role2>`-typed junction column (stored as JSON);
`Foo.orgs@roles.role1` reads that column and extracts `$.role1` (`json_extract(j."roles", '$.role1')`).

**Why it fails today:** Throws `link 'orgs' has no property 'roles'` — a tuple-typed link property is
not registered as a readable junction column, so `@roles` (and the subsequent `.role1` field access)
cannot be resolved.


---

## tests/edgeql_calls.test.ts (29)

| Count | Query group | Pattern |
|---:|---|---|
| 9 | Overload-resolution rejection not raised | An invalid `call(...)` should be rejected ("function does not exist" / "is not unique" / "newly created objects cannot be passed"), but the resolver silently binds an overload and runs it. |
| 7 | `anytype` array/tuple return wrapping | UDF returns `array<anytype>` / `tuple<...>` (incl. tuple-in-array, typed-scalar element); the generic return value is not wrapped/serialized to the right shape. |
| 5 | Object-typed param dispatch / inlining (`calls obj`) | Param is an object type (`Rectangle`, `FlatShape`, `Person`); the call's source must be the object table and the right subtype overload must be inlined. |
| 4 | Polymorphic-param overload picks wrong/missing body | Multiple overloads on `anyint`/`int64`/`anyscalar`/`str` (and nested `inner(a)`); the wrong overload body is inlined → `null`/wrong value. |
| 1 | NAMED ONLY array default binding | `NAMED ONLY b: array<anytype> = []` default is not applied; `len(b)` is computed against the passed value even when defaulted/omitted. |
| 1 | Aggregate scalar type inference | `sum()` over a homogeneous `float32` set should infer `std::float32`, not widen to `std::float64`. |
| 1 | JSON-typed array indexing in UDF | `a[idx]` where `a` is a `json` value indexes a JSON array → "malformed JSON". |
| 1 | SDL `function ... using(...)` syntax | SDL-style (non-`CREATE`) function declaration block is not parsed. |

### Overload-resolution rejection not raised (9)

- `test_edgeql_calls_03`
- `test_edgeql_calls_07`
- `test_edgeql_calls_08`
- `test_edgeql_calls_11`
- `test_edgeql_calls_18`
- `test_edgeql_calls_20`
- `test_edgeql_calls_26`
- `test_edgeql_calls_27`
- `test_edgeql_calls_obj_05`

A mismatched/ambiguous `call(...)` must fail overload resolution (the test asserts `.toThrow`), but the engine binds an overload and runs it. Covers misplaced/extra/unknown args, non-homogeneous VARIADIC/array element types, ambiguous all-default overloads, and passing freshly-mutated objects.

**Representative:** `test_edgeql_calls_08`

**EdgeQL:**
```edgeql
CREATE FUNCTION call8(a: int64 = 1, NAMED ONLY b: int64 = 2) -> int64
    USING EdgeQL $$ SELECT a + b $$;
CREATE FUNCTION call8(a: float64 = 1.0, NAMED ONLY b: int64 = 2) -> int64
    USING EdgeQL $$ SELECT 1000 + <int64>a + b $$;

SELECT call8(1);    -- 3       (int64 overload)
SELECT call8(1.0);  -- 1003    (float64 overload)
-- must raise: both overloads applicable with all-default args
SELECT call8();     -- ERROR: function call8 is not unique
```

**Relevant DDL:** none (two `call8` overloads only; differ solely by the defaulted first arg's type).

**Expected SQL:** the resolvable calls inline normally, e.g. `SELECT call8(1)` →
```sql
SELECT (1 + 2) AS "value"
```
and `SELECT call8()` must NOT compile — overload resolution must report `call8 is not unique` (ambiguous: zero positional args match both signatures via their defaults). Sibling tests want `function <name> does not exist` instead: 03 (NAMED ONLY arg passed positionally / unknown named arg `z`), 07 (extra positional / unknown named arg), 11 (`array<int32>` param given `float`/heterogeneous literal — no implicit element cast), 18 (`VARIADIC a: anytype` given mixed `int,int,str` — must be homogeneous), 20 (`anyreal`/`anyscalar` param given mismatched `str`), 26 (`array<anyscalar>` given `array<tuple>`), 27 (`array<anyint>` given `array<str>`/`array<bytes>`/`array<float>`/`array<tuple>`). `obj_05` wants `newly created or updated objects cannot be passed to functions` when an `INSERT`/`UPDATE` result is passed as an object arg.

**Why it fails today:** Argument-binding / overload matching is too permissive — it accepts mismatched positional vs NAMED-ONLY placement, extra/unknown args, non-homogeneous VARIADIC/array element types, and ambiguous all-default overloads, instead of failing resolution; and no check forbids passing freshly-mutated objects.

### `anytype` array/tuple return wrapping (7)

- `test_edgeql_calls_14`
- `test_edgeql_calls_17`
- `test_edgeql_calls_22`
- `test_edgeql_calls_31`
- `test_edgeql_calls_35a`
- `test_edgeql_calls_35b`
- `test_edgeql_calls_35c`

A UDF whose return type is `array<anytype>` / `tuple<...>` (including tuple-in-array and typed-scalar elements) inlines a body that should serialize to a nested JSON shape, then is structurally compared or further indexed/field-accessed.

**Representative:** `test_edgeql_calls_35a`

**EdgeQL:**
```edgeql
CREATE FUNCTION call35(a: int64) -> tuple<int64, tuple<foo: int64>>
    USING EdgeQL $$ SELECT (a, ((a + 1),)) $$;

SELECT call35(1);          -- [1, {"foo": 2}]
SELECT call35(1).1.foo;    -- 2
```

**Relevant DDL:** none (35c also: `CREATE SCALAR TYPE Foo extending str;` then `array<tuple<Foo>>`).

**Expected SQL:** the body inlines with `a := 1`, building the nested (positional + named-field) tuple as JSON, e.g.
```sql
SELECT json_array(1, json_object('foo', 1 + 1)) AS "value"
```
and `.1.foo` peels `json_extract(<above>, '$[1].foo')`. For 14 (`SELECT [a]` with `a := b'aaaa'`) the result must wrap a single bytes element preserving the `Uint8Array` decode; 17 picks the `str` overload (`['!!!!', a, '!!!!']`) over the `anytype` one; 22 picks the `array<anytype>` concat overload (`a ++ b` → array concat, not string concat); 31 returns `anytype` and is then indexed/field-accessed (`...[0]`, `.a`, `.1`, `.a[1]`).

**Why it fails today:** The generic (`anytype`/array/tuple) return value of an inlined UDF is not wrapped/serialized into the correct nested JSON shape (named tuple fields, typed scalar elements, bytes), so structural equality / subsequent indexing yields `null` or a malformed shape.

### Object-typed param dispatch / inlining — `calls obj` (5)

- `test_edgeql_calls_38`
- `test_edgeql_calls_40`
- `test_edgeql_calls_obj_01`
- `test_edgeql_calls_obj_02`
- `test_edgeql_calls_obj_03`

A function whose argument is an object set (e.g. `area(Rectangle)`, `area(FlatShape)` inside a shape) must lower its source to the object table and inline the most-specific subtype overload's body against that source, dispatching per-row by concrete type.

**Representative:** `test_edgeql_calls_obj_01`

**EdgeQL:**
```edgeql
CREATE FUNCTION area(s: FlatShape) -> float64 USING (-1);
CREATE FUNCTION area(s: Rectangle) -> float64 USING (s.w * s.h);
CREATE FUNCTION area(s: Circle)    -> float64 USING (s.r ^ 2 * 3.14);

SELECT FlatShape { tn := .__type__.name, area := area(FlatShape) } ORDER BY .tn;
SELECT area(Rectangle);   -- 200.0
SELECT area(Circle);      -- 314.0
```

**ESDL:**
```esdl
CREATE TYPE Shape;
CREATE TYPE FlatShape;
CREATE TYPE Rectangle EXTENDING FlatShape {
    CREATE REQUIRED PROPERTY w -> float64;
    CREATE REQUIRED PROPERTY h -> float64;
};
CREATE TYPE Circle EXTENDING FlatShape {
    CREATE REQUIRED PROPERTY r -> float64;
};
```

**Expected SQL:** with an object-typed param the call's source is the object table, and the most-specific overload body inlines against that source. `SELECT area(Rectangle)` →
```sql
SELECT (a0."w" * a0."h") AS "value"
FROM (SELECT 'default::Rectangle' AS "__source_type", "id" AS "id",
             "w" AS "w", "h" AS "h" FROM "default__rectangle") a0
```
For `area(FlatShape)` inside the shape, dispatch is per-row by the row's concrete `__source_type`: a Rectangle row uses `w*h`, a Circle row uses `r^2*3.14` — a `CASE`/`UNION` over the FlatShape extent keyed on the concrete subtype. (38: `call38(C38) -> SELECT a.name` → `SELECT a0."name" ... FROM "default__c38" a0`; 40: `r.width * r.height`; obj_02: `dimensions` returns `SET OF`; obj_03: 4 overloads keyed on `Person`/`str` combos.)

**Why it fails today:** A function call whose argument is an object set is not lowered to "source = that object table + inline the matching subtype overload's body against its columns"; per-row polymorphic dispatch by concrete `__source_type` is not done, so the body yields `null`.

### Polymorphic-param overload picks wrong/missing body (4)

- `test_edgeql_calls_12`
- `test_edgeql_calls_13`
- `test_edgeql_calls_16`
- `test_edgeql_calls_28`

Multiple overloads on polymorphic scalar params (`anyint` vs `int64`, `anyscalar` vs concrete, exact array element type, and a nested `inner(a)` call); the most-specific overload must be selected per concrete arg type.

**Representative:** `test_edgeql_calls_12`

**EdgeQL:**
```edgeql
CREATE FUNCTION call12(a: anyint) -> int64 USING EdgeQL $$ SELECT <int64>a + 100 $$;
CREATE FUNCTION call12(a: int64)  -> int64 USING EdgeQL $$ SELECT <int64>a + 1   $$;

SELECT call12(<int32>1);  -- 101  (int32 -> anyint overload)
SELECT call12(1);         -- 2    (int64 -> exact int64 overload)
```

**Relevant DDL:** none.

**Expected SQL:** pick the most-specific overload by the concrete arg type. `SELECT call12(<int32>1)` →
```sql
SELECT (CAST(CAST(1 AS INTEGER) AS INTEGER) + 100) AS "value"
```
`SELECT call12(1)` → `SELECT (CAST(1 AS INTEGER) + 1) AS "value"`. Siblings: 28 (`array<anyint>` exact vs `array<anyscalar>` fallback — `['a','b']` must take the `anyscalar` body `len(a)+1000`); 16 (overloads on `(array<anytype>,int64)` / `(array<anytype>,str)` / `(anyscalar,int64)` — index by int vs str, and string indexing via the `anyscalar` overload); 13 (nested `inner(a)`: after adding `inner(a: str)`, `call13_2('aaa')` must resolve `inner` to the `str` overload → 2, while bytes/array stay on the `anytype` overload → 1).

**Why it fails today:** Overload selection on polymorphic parameters (`anyint` vs `int64`, `anyscalar` vs concrete, exact array element type) does not pick the most-specific match (and does not re-resolve nested `inner(a)` against the bound concrete type), so the wrong body is inlined or none binds → `null`/wrong value.

### NAMED ONLY array default binding (1)

- `test_edgeql_calls_04`

A `NAMED ONLY b: array<anytype> = []` default must bind when the arg is omitted, so `len(b) = 0`.

**Representative:** `test_edgeql_calls_04`

**EdgeQL:**
```edgeql
CREATE FUNCTION call4(a: int32, NAMED ONLY b: array<anytype> = []) -> int32
    USING EdgeQL $$ SELECT a + len(b) $$;

SELECT call4(100);                 -- 100   (b defaults to [], len 0)
SELECT call4(100, b := <int32>[]); -- 100
SELECT call4(100, b := [1, 2]);    -- 102
```

**Relevant DDL:** none.

**Expected SQL:** when `b` is omitted, the default empty array binds so `len(b) = 0`. `SELECT call4(100)` →
```sql
SELECT (100 + json_array_length(COALESCE(json_array(), '[]'))) AS "value"
```
(i.e. `100 + 0`).

**Why it fails today:** The `NAMED ONLY b: array<anytype> = []` default is not substituted when the arg is omitted (binding picks up a non-empty value), so `len(b)` is non-zero and `call4(100)` returns 102 instead of 100.

### Aggregate scalar type inference (1)

- `test_edgeql_calls_10`

`INTROSPECT TYPEOF sum(...)` over a homogeneous `float32` set should fold to `std::float32`.

**Representative:** `test_edgeql_calls_10`

**EdgeQL:**
```edgeql
SELECT (INTROSPECT TYPEOF sum({<float32>1, <float32>2, <float32>3})).name;
-- std::float32   (engine returns std::float64)
```

**Relevant DDL:** none.

**Expected SQL:** `INTROSPECT TYPEOF` is a compile-time fact — the whole expression folds to a string literal of the inferred type name:
```sql
SELECT 'std::float32' AS "value"
```

**Why it fails today:** `sum()`'s return-type inference widens a homogeneous `float32` argument set to `float64` instead of keeping `float32`, so the folded type name is wrong. (All other rows in this test pass; only the all-`float32` case is wrong.)

### JSON-typed array indexing in UDF (1)

- `test_edgeql_calls_23`

Indexing `a[idx]` where the inlined arg `a` is a `json` value must extract a JSON element.

**Representative:** `test_edgeql_calls_23`

**EdgeQL:**
```edgeql
CREATE FUNCTION call23(a: anytype, idx: int64) -> anytype
    USING EdgeQL $$ SELECT a[idx] $$;
CREATE FUNCTION call23(a: anytype, idx: int32) -> anytype
    USING EdgeQL $$ SELECT a[-idx:] $$;

SELECT call23('abcde', 2);          -- "c"
SELECT call23('abcde', <int32>2);   -- "de"
SELECT call23(to_json('[{"a":"b"}]'), 0);  -- {"a": "b"}
```

**Relevant DDL:** none.

**Expected SQL:** for a `json` arg the index must extract a JSON element (and for `str` it must `substr`). `SELECT call23(to_json('[{"a":"b"}]'), 0)` →
```sql
SELECT json_extract(json('[{"a":"b"}]'), '$[0]') AS "value"
```

**Why it fails today:** Indexing `a[idx]` over a `json`-typed inlined arg produces SQL that SQLite rejects with "malformed JSON" (the json value is not being passed to `json_extract`/`json()` correctly when `a` came in as an inlined function argument).

### SDL `function ... using(...)` syntax (1)

- `test_edgeql_calls_13_sdl`

A declarative SDL `function name(...) -> T using (...);` block (not `CREATE FUNCTION`) must parse and register overloads.

**Representative:** `test_edgeql_calls_13_sdl`

**EdgeQL:**
```edgeql
function inner(a: anytype) -> str using ("anytype");
function inner(a: int64)   -> str using ("int64");
function call13_sdl(a: anytype) -> str using (inner(a));

SELECT call13_sdl(1.0);  -- "anytype"
SELECT call13_sdl(1);    -- "int64"
```

**Relevant DDL:** the SDL block above (declarative `function` declarations, not `CREATE FUNCTION`).

**Expected SQL:** once the SDL function declarations parse and register the overloads, the calls inline like the `CREATE FUNCTION` variants (`test_edgeql_calls_13`): `SELECT call13_sdl(1)` resolves `inner` to the `int64` overload →
```sql
SELECT 'int64' AS "value"
```

**Why it fails today:** Parser error `Expected 'select', 'insert', 'update', 'delete', 'for', 'configure', transaction, or DDL statement` (E_SYNTAX, line 2) — the declarative SDL `function name(...) using (...);` form is not accepted by the statement parser (only `CREATE FUNCTION ...` DDL is).


---

## tests/edgeql_advtypes.test.ts (23)

Almost all failures share one root cause: **type-intersection narrowing is dropped**. A
type-expression that involves `&` (or a nested chain `[IS A][IS B]`, or `&` mixed into a
`|`) should narrow the source to the concrete types present in **all** named branches'
closures; instead the engine emits the *base* source's closure (or a plain union of the
branch closures), leaking rows from types that belong to only one side and mis-sizing the
`__source_type IN (...)` gate. Union-only narrowing (`[IS A | B]`) works, which is why the
`basic_union*` tests pass. The one independent root cause is the `Object IS T` boolean
type-check (group "Type-check boolean in shape"), which returns a raw SQLite integer
instead of a JSON boolean.

Concrete-type closures in `advtypes.esdl` (used throughout the expected SQL):

- `Ba` → `{CBa, CBaBb, CBaBc, CBaBbBc}`
- `Bb` → `{CBb, CBaBb, CBbBc, CBaBbBc}`
- `Bc` → `{CBc, CBaBc, CBbBc, CBaBbBc}`
- `Ba & Bb` → `{CBaBb, CBaBbBc}` · `Bb & Bc` → `{CBbBc, CBaBbBc}` · `Ba & Bc` → `{CBaBc, CBaBbBc}`
- `Ba & Bb & Bc` → `{CBaBbBc}`

| Count | Query group | Pattern |
|---:|---|---|
| 8 | Update complex type | `UPDATE Ba[IS Bb & Bc] SET {...}` — UPDATE only the rows in the intersection closure |
| 6 | Complex intersection (source narrowing) | `SELECT {CBa, Ba[IS Bb & Bc]}{...}` / `{Ba,XBa}[is Bb\|XBa]` / chained `x:=Ba[IS Bb]; x[IS Bc]` — narrow source to the concrete-type intersection, then `__source_type IN (...)`-gate each `[IS T].member` |
| 4 | Type-check boolean in shape | `SELECT Object[IS …]{ x := Object IS (Ba & Bb) }` — membership test must return a JSON boolean (and use the **intersection** closure) |
| 2 | Basic intersection | `SELECT Ba[IS Bb].bb` / `.__type__.name` — single-level `&`-style narrowing dropped |
| 2 | WITH-binding & FOR intersection | `WITH x := Ba SELECT x[IS Bb]{...}` / `FOR x IN Ba UNION (x[IS Bb]{...})` — narrowing dropped when applied to a binding / iteration var |
| 1 | Backlink intersection | `A.<l_a[is S & T]{name}` — narrowing dropped on a backlink source |

### Update complex type (8)

- `test_edgeql_advtypes_update_complex_type_01`
- `test_edgeql_advtypes_update_complex_type_02`
- `test_edgeql_advtypes_update_complex_type_03`
- `test_edgeql_advtypes_update_complex_type_04`
- `test_edgeql_advtypes_update_complex_type_05`
- `test_edgeql_advtypes_update_complex_type_06`
- `test_edgeql_advtypes_update_complex_type_07`
- `test_edgeql_advtypes_update_complex_type_08`

`UPDATE Ba[IS …] SET {...}` over an intersection/mixed type-expr: the write set is the
intersection closure of the type-expr, one UPDATE per surviving concrete table; a re-select
of the updated rows feeds `temp`, shaped as in the "complex intersection" group.

**Representative:** `test_edgeql_advtypes_update_complex_type_04`

**EdgeQL:**
```edgeql
with
    temp := (
        update Ba[is Bb & Bc] set {
            ba := .ba ++ '!',
            bb := .bb + 1,
            bc := .bc + 0.1,
        }
    )
select temp {
    tn := .__type__.name,
    [IS Ba].ba,
    [IS Bb].bb,
    [IS Bc].bc,
}
order by .tn then .ba then .bb then .bc;
```

**Relevant ESDL:**
```esdl
abstract type Ba { required property ba -> str; }
abstract type Bb { required property bb -> int64; }
abstract type Bc { required property bc -> float64; }

type CBa     extending Ba;
type CBaBb   extending Ba, Bb;
type CBaBc   extending Ba, Bc;
type CBbBc   extending Bb, Bc;
type CBaBbBc extending Ba, Bb, Bc;
```

**Expected SQL:**
`Ba & Bb & Bc` narrows the *write set* to `{CBaBbBc}`; only that table is updated (other
concrete types of `Ba` are untouched). Each surviving column is updated in place:
```sql
UPDATE "default__cbabbbc"
SET "ba" = "ba" || '!',
    "bb" = "bb" + 1,
    "bc" = "bc" + 0.1;
-- RETURNING / re-select of the updated rows feeds `temp`, shaped as in the
-- "complex intersection" group (source = {CBaBbBc}).
```
For mixed exprs (`_03` `Ba[is Bb|Bc]`, `_05` `Ba[IS CBa | Bb & Bc]`, `_07`
`Object[IS (Ba&Bb)|(Ba&Bc)]`, `_08` `{Object[IS Ba&Bb], Object[IS Ba&Bc]}`) the UPDATE
fans out one statement per table in the **intersection** closure of the type-expr, e.g.
`_07` → update `default__cbabb`, `default__cbabbbc`, `default__cbabc`. `_01` `Ba[is Bb]`
→ `{CBaBb, CBaBbBc}`; `_02`/`_06` chain/set to the same closures.

**Why it fails today:** the `&` narrowing on the UPDATE target is dropped — the write set
collapses (e.g. `Ba & Bb & Bc` resolves to no concrete table, so `_04` returns **0** rows
where 2 are expected) or expands to `Ba`'s full closure, updating/altering rows that
shouldn't change and making the verification re-select return extra/missing rows.

### Complex intersection (source narrowing) (6)

- `test_edgeql_advtypes_complex_intersection_04`
- `test_edgeql_advtypes_complex_intersection_11`
- `test_edgeql_advtypes_complex_intersection_12`
- `test_edgeql_advtypes_complex_intersection_13`
- `test_edgeql_advtypes_complex_intersection_16`
- `test_edgeql_advtypes_complex_intersection_18`

A `&` (or `&`-mixed-into-`|`) narrowing applied to a SELECT source — including inside a
set-element branch (`{CBa, Ba[IS Bb & Bc]}`), on a set source (`{Ba,XBa}[is Bb|XBa]`), or
chained through a `WITH` binding (`x := Ba[IS Bb]; x[IS Bc]`). The narrowed source must be
the intersection closure of the expanded boolean type-expr; each `[IS T].member` is gated.

**Representative:** `test_edgeql_advtypes_complex_intersection_04`

**EdgeQL:**
```edgeql
SELECT {CBa, Ba[IS Bb & Bc]} {
    tn := .__type__.name,
    ba,
    [IS Bb].bb,
    [IS Bc].bc,
}
ORDER BY .ba;
```

**Relevant ESDL:** (same `Ba`/`Bb`/`Bc` + `C*` hierarchy as above)

**Expected SQL:**
The set is the UNION ALL of two branches: `CBa` (closure `{CBa}`) and `Ba[IS Bb & Bc]`
(closure `Ba ∩ Bb ∩ Bc = {CBaBbBc}`). `[IS Bb].bb`/`[IS Bc].bc` are gated by source type:
```sql
SELECT a0."id" AS "id",
       a0."__source_type" AS "__source_type",
       a0."__source_type" AS "tn",
       a0."ba" AS "ba",
       (CASE WHEN a0."__source_type" IN ('default::CBaBb','default::CBaBbBc') THEN a0."bb" END) AS "bb",
       (CASE WHEN a0."__source_type" IN ('default::CBaBc','default::CBbBc','default::CBaBbBc') THEN a0."bc" END) AS "bc"
FROM (
    SELECT 'default::CBa'     AS "__source_type", "id", "ba", NULL AS "bb", NULL AS "bc" FROM "default__cba"
    UNION ALL
    SELECT 'default::CBaBbBc' AS "__source_type", "id", "ba", "bb",        "bc"          FROM "default__cbabbbc"
) a0
ORDER BY a0."ba";
-- expected: cba0, cba1, cba8/bb8/bc8.5, cba9/bb9/bc9.5
```
(`_11` `{Object[IS Ba&Bb], Object[IS Ba&Bc]}` → branches `{CBaBb,CBaBbBc}` and
`{CBaBc,CBaBbBc}` (CBaBbBc duplicated); `_12` `{Ba,XBa}[is Bb|XBa]` → `(Ba∪XBa) ∩
(Bb∪XBa) = {CBaBb,CBaBbBc,XBa}`; `_13` `{Ba[is Bb], XBa}` → `{CBaBb,CBaBbBc}` ∪ `XBa`;
`_16` `{CBa, Ba[is Bb]}` / `{Bb[is Ba & Bc | CBaBb]}`; `_18` `WITH x := Ba[IS Bb] SELECT
x[IS Bc]` chains to `Ba ∩ Bb ∩ Bc = {CBaBbBc}`.)

**Why it fails today:** the `&` narrowing on the set-element / chained source is dropped —
`bin/inspect.ts sql` for `{CBa, Ba[IS Bb & Bc]}` shows the second branch emitting `Ba`'s
**full** closure `{CBa, CBaBb, CBaBbBc, CBaBc}` instead of `{CBaBbBc}`, leaking
`CBaBb`/`CBaBc`/extra `CBa` rows.

### Type-check boolean in shape (4)

- `test_edgeql_advtypes_complex_type_checking_01`
- `test_edgeql_advtypes_complex_type_checking_02`
- `test_edgeql_advtypes_complex_type_checking_03`
- `test_edgeql_advtypes_complex_type_checking_04`

A shape computed `x := Object IS <type-expr>` is a row-level boolean membership test against
the type-expr's concrete-type closure. The result must be a JSON boolean (`true`/`false`),
and for `&` the closure must be the **intersection** (multiple values), not a single
collapsed type.

**Representative:** `test_edgeql_advtypes_complex_type_checking_03`

**EdgeQL:**
```edgeql
SELECT Object[IS Ba | Bb | Bc] {
    tn := .__type__.name,
    ab := Object IS (Ba & Bb),
    ac := Object IS (Ba & Bc),
    bc := Object IS (Bb & Bc),
}
ORDER BY .tn;
```

**Relevant ESDL:** (same `Ba`/`Bb`/`Bc` + `C*` hierarchy)

**Expected SQL:**
Each `IS (X & Y)` is a boolean over the intersection closure (two values), cast to JSON
boolean; the source is the closure of `(Ba | Bb | Bc)`:
```sql
SELECT a0."id" AS "id",
       a0."__source_type" AS "__source_type",
       a0."__source_type" AS "tn",
       json(CASE WHEN a0."__source_type" IN ('default::CBaBb','default::CBaBbBc') THEN 'true' ELSE 'false' END) AS "ab",
       json(CASE WHEN a0."__source_type" IN ('default::CBaBc','default::CBaBbBc') THEN 'true' ELSE 'false' END) AS "ac",
       json(CASE WHEN a0."__source_type" IN ('default::CBbBc','default::CBaBbBc') THEN 'true' ELSE 'false' END) AS "bc"
FROM (
    SELECT 'default::CBa'     AS "__source_type", "id" FROM "default__cba"
    UNION ALL SELECT 'default::CBb'     AS "__source_type", "id" FROM "default__cbb"
    UNION ALL SELECT 'default::CBc'     AS "__source_type", "id" FROM "default__cbc"
    UNION ALL SELECT 'default::CBaBb'   AS "__source_type", "id" FROM "default__cbabb"
    UNION ALL SELECT 'default::CBaBc'   AS "__source_type", "id" FROM "default__cbabc"
    UNION ALL SELECT 'default::CBbBc'   AS "__source_type", "id" FROM "default__cbbbc"
    UNION ALL SELECT 'default::CBaBbBc' AS "__source_type", "id" FROM "default__cbabbbc"
) a0
ORDER BY a0."__source_type";
```
(`_01` `Object IS Ba` → `IN (Ba`'s 4 closure values`)`; `_02` `Object IS (Ba | Bb)` →
union closure; `_04` `Object IS (Ba & Bb & Bc)` → `IN ('default::CBaBbBc')`.)

**Why it fails today:** two bugs. (1) The `IS` test emits a raw SQLite integer — the test
gets `1`/`0` where `true`/`false` is expected (the failing surface for all four). (2) For
`&`, `Object IS (Ba & Bb)` emits `__source_type IN (?)` — a **single** value (the `&` of
named symbols collapses to one type) instead of the two-value concrete-closure
`{CBaBb, CBaBbBc}`.

### Basic intersection (2)

- `test_edgeql_advtypes_basic_intersection_01`
- `test_edgeql_advtypes_basic_intersection_03`

Single-level `Ba[IS Bb]` narrows to `Ba ∩ Bb = {CBaBb, CBaBbBc}`, then reads a scalar
(`.bb`) or `.__type__.name` off just those two tables.

**Representative:** `test_edgeql_advtypes_basic_intersection_03`

**EdgeQL:**
```edgeql
SELECT Ba[IS Bb].bb;
```

**Relevant ESDL:** (same `Ba`/`Bb` + `C*` hierarchy)

**Expected SQL:**
`Ba[IS Bb]` narrows to `Ba ∩ Bb = {CBaBb, CBaBbBc}`; `.bb` reads the column from just those
two tables:
```sql
SELECT a0."bb" AS "value"
FROM (
    SELECT 'default::CBaBb'   AS "__source_type", "id" AS "id", "bb" AS "bb" FROM "default__cbabb"
    UNION ALL
    SELECT 'default::CBaBbBc' AS "__source_type", "id" AS "id", "bb" AS "bb" FROM "default__cbabbbc"
) a0;
-- expected values: 2, 3, 8, 9
```
(`_01` `Ba[IS Bb].__type__.name` over the same `{CBaBb, CBaBbBc}` source → those two type
names.)

**Why it fails today:** narrowing is dropped — `bin/inspect.ts sql` for `Ba[IS Bb].bb`
emits the **union** closure `{CBaBb, CBaBbBc, CBb, CBbBc}` (leaking the `Bb`-only
`CBb`/`CBbBc` → extra values 0,1,6,7); `Ba[IS Bb].__type__.name` leaks `Ba`-only types.

### WITH-binding & FOR intersection (2)

- `test_edgeql_advtypes_complex_intersection_17`
- `test_edgeql_advtypes_for_complex_intersection_01`

`x[IS Bb]` narrows a `WITH`-binding / `FOR`-iteration var whose value is `Ba`'s closure to
`Ba ∩ Bb = {CBaBb, CBaBbBc}`; `ba`/`bb` are present in both, `[IS Bc].bc` is gated.

**Representative:** `test_edgeql_advtypes_complex_intersection_17`

**EdgeQL:**
```edgeql
WITH x := Ba
SELECT x[IS Bb] {
    tn := .__type__.name,
    ba,
    bb,
    [IS Bc].bc,
}
```
`for_complex_intersection_01` is the FOR form of the same shape:
```edgeql
FOR x IN Ba UNION (
    x[IS Bb] { tn := .__type__.name, ba, bb, [IS Bc].bc }
)
```

**Relevant ESDL:** (same `Ba`/`Bb`/`Bc` + `C*` hierarchy)

**Expected SQL:**
```sql
SELECT a0."id" AS "id",
       a0."__source_type" AS "__source_type",
       a0."__source_type" AS "tn",
       a0."ba" AS "ba",
       a0."bb" AS "bb",
       (CASE WHEN a0."__source_type" IN ('default::CBaBbBc') THEN a0."bc" END) AS "bc"
FROM (
    SELECT 'default::CBaBb'   AS "__source_type", "id", "ba", "bb", NULL AS "bc" FROM "default__cbabb"
    UNION ALL
    SELECT 'default::CBaBbBc' AS "__source_type", "id", "ba", "bb", "bc"        FROM "default__cbabbbc"
) a0;
-- expected: cba2/bb2, cba3/bb3, cba8/bb8/bc8.5, cba9/bb9/bc9.5
```

**Why it fails today:** narrowing applied to a `WITH`-binding / `FOR`-var is dropped —
`WITH x := Ba SELECT x[IS Bb].ba` emits the union closure `{CBaBb, CBaBbBc, CBb, CBbBc}`
(leaking the `Bb`-only `CBb`/`CBbBc`).

### Backlink intersection (1)

- `test_edgeql_advtypes_complex_intersection_15`

A backlink (`A.<l_a`) whose source side carries an `&` narrowing — narrow the source to the
concrete types extending **both** named types.

**Representative:** `test_edgeql_advtypes_complex_intersection_15`

**EdgeQL:**
```edgeql
SELECT A.<l_a[is S & T] { name } ORDER BY .name;
```

**Relevant ESDL:**
```esdl
abstract type R { required property name -> str { delegated constraint exclusive; } }
type A extending R;
type S extending R { required property s -> str; multi link l_a -> A; }
type T extending R { required property t -> str; multi link l_a -> A; }
abstract type U { required property u -> str; }
type V extending U, S, T;   -- the only S & T concrete type
```

**Expected SQL:**
Backlink over `l_a`, then narrow the source side to `S ∩ T = {V}` (the only concrete type
extending both). The source is restricted to `default__v`; junction rows still come from
both `S`'s and `V`'s `l_a` tables:
```sql
SELECT DISTINCT a0."id" AS "id", a0."__source_type" AS "__source_type", a0."name" AS "name"
FROM (
    SELECT t0.*
    FROM (SELECT 'default::A' AS "__source_type", "id" AS "id" FROM "default__a") s0
    JOIN (SELECT "rowid", * FROM "default__s__l_a"
          UNION ALL SELECT "rowid", * FROM "default__v__l_a") a1
      ON a1."target" = s0."id"
    JOIN (SELECT 'default::V' AS "__source_type", "id" AS "id", "name" AS "name"
          FROM "default__v") t0
      ON t0."id" = a1."source"
) a0
ORDER BY a0."name";
-- expected: only "vvv"
```

**Why it fails today:** the `& T` narrowing on the backlink source is dropped —
`bin/inspect.ts sql` shows the `t0` source emitting the `[is S | T]` union (`S UNION V`)
instead of `S ∩ T = {V}`, so `sss`/`ttt` leak into the result alongside `vvv`.


---

## tests/edgeql_for.test.ts (19)

| Count | Query group | Pattern |
|---:|---|---|
| 12 | for in computable | `FOR x IN <set> UNION (SELECT .deck {…})` inside a computed shape field, often wrapped in `assert_*`/`DISTINCT`/a 1-tuple — the FOR body references the *outer* object (`User.deck` / `.deck`), so it must compile to a per-element subquery *correlated to the outer row* while still iterating per FOR element. |
| 2 | for fake group | `FOR x IN <set> UNION { key := …, elements := … }` builds one free-object per element; a nested object/link field must be a correlated subquery, not a fan-out join. |
| 2 | for empty | `FOR x IN {} UNION ()` over a statically-empty / untyped iterator must be **rejected** with `FOR statement has iterator of indeterminate type`. |
| 1 | for and computable | `FOR x IN {1,2} UNION (SELECT User { m := x })` — the iterator value `x` is projected as a computed field on every iterated object and later counted. |
| 1 | for mix | `FOR X IN {Card.name, User.name} UNION count(User.friends)` — iterating a heterogeneous set while the body is an aggregate that *ignores* the iterator. |
| 1 | for optional | `FOR optional x IN (<empty>,) UNION …` — an optional FOR over an empty set must still yield one body row (with `x` empty), modelled as a LEFT/OUTER correlation. |

### for in computable (12)

- `test_edgeql_for_in_computable_02`
- `test_edgeql_for_in_computable_02b`
- `test_edgeql_for_in_computable_02d`
- `test_edgeql_for_in_computable_02e`
- `test_edgeql_for_in_computable_04` (xerror: tuple-element @letter not a singleton)
- `test_edgeql_for_in_computable_05`
- `test_edgeql_for_in_computable_06`
- `test_edgeql_for_in_computable_07`
- `test_edgeql_for_in_computable_08`
- `test_edgeql_for_in_computable_09` (xerror: 'letter' does not exist)
- `test_edgeql_for_in_computable_10` (xerror: same letter for both objects)
- `test_edgeql_for_in_computable_12`

**Representative:** `test_edgeql_for_in_computable_12`

**EdgeQL:**
```edgeql
SELECT User {
    select_deck := (assert_exists((
        FOR letter IN {'I', 'B'}
        UNION (
            SELECT User.deck {
                name,
                letter := letter
            }
            FILTER User.deck.name[0] = letter
        )
    )),)
} FILTER .name = 'Alice';
```
Expected: per Alice, a 1-tuple wrapping the cards whose name starts with `I` or `B`, each tagged with the matching `letter`:
`[[{name:"Bog monster", letter:"B"}, {name:"Imp", letter:"I"}]]`.

**Relevant ESDL:**
```esdl
type User extending Named {
    multi deck: Card {
        count: int64 { default := 1; };
    }
}
type Card extending Named {        # Named: required name: str
    required element: str;
    required cost: int64;
}
type SpecialCard extending Card;
```

**Expected SQL:**
The whole `select_deck` field is a correlated `json_group_array` subquery. The FOR set literal `{'I','B'}` is a 2-row source CROSS JOINed with the FOR body, but the body's `User.deck` hop stays **correlated to the outer User row `a0`** (`aJ."source" = a0."id"`), and the FILTER `User.deck.name[0] = letter` becomes an existential predicate comparing the deck card's name-prefix to the current `letter`. The `(…,)` wrap then nests the whole array as a single tuple element:
```sql
SELECT
  a0."id" AS "id",
  a0."__source_type" AS "__source_type",
  json_array((
    SELECT json_group_array(json("item")) FROM (
      SELECT json_object('name', a2."name", 'letter', a1."value") AS "item"
      FROM (SELECT 'I' AS "value" UNION ALL SELECT 'B' AS "value") a1
      CROSS JOIN (SELECT 'default::Card' AS "__source_type","id","name" FROM "default__card"
            UNION ALL
            SELECT 'default::SpecialCard',"id","name" FROM "default__specialcard") a2
      JOIN "default__user__deck" aJ ON aJ."target" = a2."id" AND aJ."source" = a0."id"  -- correlated to outer User a0
      WHERE substr(a2."name",1,1) = a1."value"                                          -- name[0] = letter
    )
  )) AS "select_deck"
FROM (SELECT 'default::User' AS "__source_type","id","name" FROM "default__user"
      UNION ALL SELECT 'default::Bot',"id","name" FROM "default__bot") a0
WHERE EXISTS (SELECT 1 FROM (SELECT ? AS "value") WHERE "value" = a0."name");   -- .name = 'Alice'
```

**Why it fails today:** inside an `assert_*`/`DISTINCT`/1-tuple wrapper the FOR loses its iteration. The engine collapses the FOR body into a *single* correlated scalar subquery picking one deck card and folds the iterator `letter` into `json_group_array("value")` (yielding `["I","B"]` once) instead of CROSS JOINing the `{'I','B'}` source with the body and re-correlating each per-letter deck row — observed output is one card with both letters, not two cards each tagged with its own letter. The plain unwrapped `SELECT User { select_deck := (FOR … UNION (SELECT User.deck {…})) }` form already compiles correctly; the wrapped variants (assert_distinct/assert_exists/`(…,)` — 06/07/08/10/12), the nested double-FOR + UPDATE variants (02/02b/02d/02e) and the bare `.deck.name`/`@letter` body (05/04/09) all hit this broken correlation. Tests 04/09/10 are documented xerrors (`@letter`/`letter` tuple-singleton & scoping not yet implemented).

### for fake group (2)

- `test_edgeql_for_fake_group_01b`
- `test_edgeql_for_fake_group_01c`

**Representative:** `test_edgeql_for_fake_group_01c`

**EdgeQL:**
```edgeql
with GR := (
    for x in {'Earth', 'Water'} union {
        key := {element := x},
        elements := (select Card filter .element = x),
    }
)
select GR {
  key: {element},
  elements: {name},
}
order by .key.element;
```
Expected: exactly **2** rows (one free-object per element), each with its matching `elements` list:
`[{key:{element:"Earth"}, elements:[{name:"Dwarf"},{name:"Golem"}]}, {key:{element:"Water"}, elements:[{name:"Bog monster"},{name:"Giant turtle"}]}]`.

**Relevant ESDL:**
```esdl
type Card extending Named {        # Named: required name: str
    required element: str;
}
type SpecialCard extending Card;
```

**Expected SQL:**
The FOR produces one free-object **per element value**; the `elements` field is a *correlated subquery* over `Card` (filtered by the current `x`), NOT a join that fans the row out:
```sql
SELECT
  json_object(
    'key', (SELECT json_object('element', a0."value")),
    'elements', COALESCE((
        SELECT json_group_array(json_object('name', a1."name"))
        FROM (SELECT 'default::Card' AS "__source_type","id","name","element" FROM "default__card"
              UNION ALL
              SELECT 'default::SpecialCard',"id","name","element" FROM "default__specialcard") a1
        WHERE a1."element" = a0."value"                              -- .element = x
    ), '[]')
  ) AS "value"
FROM (SELECT 'Earth' AS "value" UNION ALL SELECT 'Water' AS "value") a0
ORDER BY a0."value";    -- order by .key.element
```

**Why it fails today:** the `elements := (select Card filter .element = x)` field compiles to a **CROSS JOIN** of the `{'Earth','Water'}` source with `Card`, fanning the result into 18 rows (one per element×card pair) instead of 2 free-objects — observed `expected 18 to be 2`. The link/object-valued field of a FOR-built free-object must be a correlated subquery so each iterated element stays a single row. (`01a` passes because it has only the scalar `key` field and no fan-out source; `01b` already breaks despite only selecting `key`, because the `elements` source still joins in.)

### for empty (2)

- `test_edgeql_for_empty_01`
- `test_edgeql_for_empty_02`

**Representative:** `test_edgeql_for_empty_01`

**EdgeQL:**
```edgeql
SELECT (FOR x in {} UNION ());
-- and (02):
WITH s := {} SELECT (FOR x in {s} UNION ());
```
Expected: a **compile-time error** matching `FOR statement has iterator of indeterminate type` (the iterator's element type cannot be inferred from an empty/untyped set).

**Relevant ESDL:** n/a (no schema objects involved).

**Expected SQL:**
```sql
-- none — must throw at compile time with "FOR statement has iterator of indeterminate type"
```

**Why it fails today:** the engine does **not** raise the indeterminate-iterator-type error; it silently compiles (or produces an empty result) instead of throwing, so `expected [Function] to throw an error` fails. Needs an inference guard: a FOR whose iterator type resolves to the empty/unknown type must be a hard error.

### for and computable (1)

- `test_edgeql_for_and_computable_05`

**Representative:** `test_edgeql_for_and_computable_05`

**EdgeQL:**
```edgeql
WITH X := (SELECT (FOR x IN {1,2} UNION (
    SELECT User { m := x }))),
SELECT count(X.m);
```
Expected: `[8]` — 4 Users × 2 iterations of `x` = 8 instances, each carrying a (singleton) computed `m`, so `count(X.m)` = 8.

**Relevant ESDL:**
```esdl
type User extending Named { … }   # 4 users in the dataset (Alice, Bob, Carol, Dave)
```

**Expected SQL:**
The FOR CROSS JOINs the `{1,2}` source with every `User`, attaching `x` as the computed field `m`; `count(X.m)` counts the non-empty `m` over that 8-row product:
```sql
SELECT count(*) FROM (
  SELECT a1."value" AS "m"
  FROM (SELECT 'default::User' AS "__source_type","id" FROM "default__user"
        UNION ALL SELECT 'default::Bot',"id" FROM "default__bot") a0
  CROSS JOIN (SELECT 1 AS "value" UNION ALL SELECT 2 AS "value") a1
  WHERE a1."value" IS NOT NULL
);   -- => 8
```

**Why it fails today:** the computed field `m := x` is not carried through the FOR/`WITH X` binding, so `X.m` resolves to NULL/empty and `count` returns null — observed `expected null to deeply equal 8`. The iterator value must survive as a projected computed pointer on the iterated object set.

### for mix (1)

- `test_edgeql_for_mix_04`

**Representative:** `test_edgeql_for_mix_04`

**EdgeQL:**
```edgeql
FOR X IN {Card.name, User.name}
# this should be just [3] for each name (9 + 4 of names)
UNION count(User.friends);
```
Expected: thirteen `3`s — `count(User.friends)` is evaluated once per element of the 13-element iterator set (9 Card names + 4 User names), and `User.friends` has cardinality 3 in the dataset, independent of `X`.

**Relevant ESDL:**
```esdl
type User extending Named {
    multi friends: User { nickname: str; }
}
type Card extending Named { … }
```

**Expected SQL:**
The iterator is the UNION ALL of all Card names and User names (13 rows); the body is a *scalar aggregate that does not reference X*, so each iterated row yields the same constant count. The aggregate must be evaluated **per iterated row** (correlated to the X source), not collapsed to a single row. `count(User.friends)` reads the `default__user__friends` junction:
```sql
SELECT
  (SELECT count(*) FROM "default__user__friends") AS "value"   -- count(User.friends) = 3
FROM (
  SELECT a."name" AS "value" FROM ( … Card union … ) a            -- 9 Card names
  UNION ALL
  SELECT a."name" AS "value" FROM ( … User union … ) a            -- 4 User names
) x;   -- 13 rows -> thirteen 3s
```

**Why it fails today:** the FOR collapses to a single output row instead of iterating once per element — observed `expected 1 to be 13`. When the FOR body ignores the iterator variable, the engine emits the body once rather than CROSS JOINing it against the (13-row) iterator source.

### for optional (1)

- `test_edgeql_for_optional_01`

**Representative:** `test_edgeql_for_optional_01`

**EdgeQL:**
```edgeql
for optional x in
    ((select User filter .name = 'George'),)
union x.0.deck_cost ?? 0;
```
Expected: `[0]` — `'George'` does not exist, so the optional iterator binds `x` to the empty set, but `for optional` still yields **one** body row; `x.0.deck_cost` is empty and `?? 0` gives `0`. (Other sub-cases in the same test exercise `for optional x in (<Card>{},)` nested inside an outer non-optional FOR, expecting the outer row to survive.)

**Relevant ESDL:**
```esdl
type User extending Named {
    multi deck: Card { count: int64 { default := 1; } };
    property deck_cost := sum(.deck.cost);
}
```

**Expected SQL:**
`for optional` is a LEFT-style correlation: the iterator source is LEFT JOINed (so one row survives even when empty), and the body reads `x` as possibly-NULL. The empty tuple `(<empty>,)` source produces a single all-NULL row:
```sql
SELECT COALESCE(
    (SELECT SUM(aC."cost")                              -- x.0.deck_cost
     FROM "default__user__deck" aJ
     JOIN ( … Card … ) aC ON aC."id" = aJ."target"
     WHERE aJ."source" = x_user."id"),
    0) AS "value"
FROM (SELECT 1) one                                     -- guarantees one row
LEFT JOIN (
   SELECT a0."id" AS "user_id"
   FROM ( … User … ) a0
   WHERE EXISTS (SELECT 1 FROM (SELECT 'George' AS "value") WHERE "value" = a0."name")
) x_user ON 1;   -- empty -> x_user.* NULL -> deck_cost empty -> COALESCE => 0
```

**Why it fails today:** the optional iterator's correlation alias is not materialised when the set is empty — observed `no such column: g0.id` (the body references the iterated User's `id` but the optional source is compiled as an inner, droppable join rather than a row-preserving outer join). `for optional` needs a row-preserving (LEFT) correlation so the single body row is emitted with `x` empty.


---

## tests/edgeql_expr_aliases.test.ts (18)

| Count | Query group | Pattern |
|---:|---|---|
| 3 | aliases if/else (set-valued conditional) | `A IF cond ELSE B` where A/cond/B are independent sets; FOR-over IF/ELSE chains |
| 3 | aliases nested (computed link in alias shape) | schema `alias X := T { link := T.<back[IS U] {...} }`; single-link cardinality + computed prop in nested shape |
| 3 | computable nested (WITH-binding computed link/field) | `WITH C := T { l := .<x }` then re-project/access the WITH-added computed; nested per-binding counts |
| 2 | aliases filter (alias as IN/NOT IN operand) | `SELECT Alias FILTER Alias IN/NOT IN <set>` — alias used as whole-object set operand inside FILTER |
| 2 | alias error-message expectations | engine must *raise* a specific error (backlink through computed link; alias link-helper type) |
| 1 | computable aliased link | alias-redefined link (`my_friends := User.friends`) projected with a link property `@nickname` |
| 1 | aliases basic (named-tuple set alias) | `CREATE ALIAS scores := SELECT { (name:=…, score:=…, …), … }` then `SELECT scores ORDER BY scores.name` |
| 1 | aliases create (redefined link w/ computed prop) | `CREATE ALIAS DCard := SELECT Card { owners := (... { name_upper := str_upper(.name) }) }` |
| 1 | aliases array of array | array-of-array alias unpacked twice with nested `array_agg`/`for`/`array_unpack` |
| 1 | aliases introspection | `schema::Type.from_alias`, `schema::Tuple`/`TupleElement`, alias link-helper types in introspection metadata |

### aliases if/else (set-valued conditional) (3)

- `test_edgeql_aliases_if_else_02`
- `test_edgeql_aliases_if_else_03`
- `test_edgeql_aliases_if_else_04`

`A IF cond ELSE B` is set-valued in EdgeQL: when the condition (and/or either branch) is a multi-set, the result is the cross-product of independent sets, not a scalar `CASE`. These also exercise FOR-over IF/ELSE chains and multi-set path projections that must keep duplicates and stay correlated per row.

**Representative:** `test_edgeql_aliases_if_else_03`

**EdgeQL:**
```edgeql
-- part 1 (multi-set projection, must keep duplicates):
SELECT _ := User.deck.element ORDER BY _;
-- expected: ["Air","Air","Air","Earth","Earth","Fire","Fire","Water","Water"]  (9 rows, dups kept)

-- part 3 (set of two independent boolean sets, per-User):
SELECT _ := {User.name[0] = 'A', EXISTS User.friends} ORDER BY _;
-- expected: [false, false, false, true, true]   (5 rows)

-- part 4 (set-valued IF with set-valued condition => cross-product):
SELECT _ :=
    User.deck.element
    IF {User.name[0] = 'A', EXISTS User.friends} ELSE
    <str>User.deck.cost
ORDER BY _;
-- expected: 45 rows (every (cond-element) pair independently chooses the
--           element branch when true and the cost branch when false)
```

**Relevant ESDL:**
```edgeql
type User extending Named {
    multi deck: Card { count: int64 { default := 1 }; }
    property deck_cost := sum(.deck.cost);
    multi friends: User { nickname: str; }
}
type Card extending Named { required element: str; required cost: int64; }
-- alias: SELECT _ := <expr> just names the SET-OF result; no schema alias needed
```

**Expected SQL:**
```sql
-- part 1: NO DISTINCT — every (User, deck-card) row contributes one element.
SELECT a0."element" AS "value"
FROM (SELECT 'default::User' AS "__source_type","id" FROM "default__user"
      UNION ALL SELECT 'default::Bot',"id" FROM "default__bot") u
JOIN "default__user__deck" pj0 ON pj0."source" = u."id"
JOIN (SELECT "id","element" FROM "default__card"
      UNION ALL SELECT "id","element" FROM "default__specialcard") a0
  ON a0."id" = pj0."target"
ORDER BY a0."element" ASC;

-- part 3: the set {A, B} = UNION ALL of two PER-USER sets (EXISTS friends
-- must be correlated to each User row, not evaluated globally once):
SELECT "value" FROM (
  SELECT (CASE WHEN substr(u."name",1,1) = ? THEN json('true') ELSE json('false') END) AS "value"
    FROM <user-source> u
  UNION ALL
  SELECT (CASE WHEN EXISTS (SELECT 1 FROM "default__user__friends" f WHERE f."source" = u."id")
               THEN json('true') ELSE json('false') END) AS "value"
    FROM <user-source> u
) ORDER BY "value" ASC;

-- part 4: A IF cond ELSE B is a SET cross-product, NOT a scalar CASE that
-- collapses cond to one boolean. Conceptually:
SELECT CASE WHEN c."value" THEN e."value" ELSE k."value" END AS "value"
FROM <user u>
   , (cond set per u: name[0]='A' UNION ALL EXISTS friends) c
   CROSS JOIN (element set per u: u.deck.element) e        -- iterated independently
   CROSS JOIN (cost set per u: <str>u.deck.cost) k
ORDER BY "value" ASC;   -- 45 rows
```

**Why it fails today:** set-valued IF/ELSE is lowered to a scalar `CASE WHEN`, collapsing the set-valued condition (via `json_group_array`/`EXISTS`) to one boolean and dropping the cross-product; also a spurious `DISTINCT` is added on the multi-set path projection (`User.deck.element`) and `EXISTS User.friends` is decorrelated (computed once globally instead of per-User).

### aliases nested (computed link in alias shape) (3)

- `test_edgeql_aliases_nested_01`
- `test_edgeql_aliases_nested_02`
- `test_edgeql_aliases_nested_03`

A schema alias redefines a link as a computed backlink (`winner := Award.<awards[IS User] { name_upper := ... }`). Because `awards` is exclusive, `winner` is single-cardinality, so the nested shape must serialize as one object (or `null`), not an array.

**Representative:** `test_edgeql_aliases_nested_01`

**EdgeQL:**
```edgeql
SELECT AwardAlias {
    name,
    winner: { name }
} ORDER BY .name;
-- expected: winner is a SINGLE object, e.g. {"name":"1st","winner":{"name":"Alice"}}
```

**Relevant ESDL:**
```edgeql
type User extending Named {
    multi awards: Award { constraint exclusive; }  -- exclusive => winner is single
}
type Award extending Named { link winner := .<awards[is User]; };

alias AwardAlias := (
    Award {
        # single link, because awards are exclusive
        winner := Award.<awards[IS User] {
            name_upper := str_upper(.name)
        }
    }
);
```

**Expected SQL:**
```sql
-- winner is SINGLE: wrap the correlated array in json_extract(COALESCE(arr,'[]'),'$[0]')
SELECT a0."id" AS "id", a0."__source_type", a0."name" AS "name",
  json(COALESCE(json_extract(COALESCE((
      SELECT json_group_array(json_object(
               'id', a1."id", '__source_type', a1."__source_type", 'name', a1."name"))
      FROM (SELECT 'default::User' AS "__source_type","id","name" FROM "default__user"
            UNION ALL SELECT 'default::Bot',"id","name" FROM "default__bot") a1
      JOIN "default__user__awards" a2 ON a2."source" = a1."id"
      WHERE a2."target" = a0."id"
      ORDER BY a2."rowid"
    ), '[]'), '$[0]'), 'null')) AS "winner"
FROM (SELECT 'default::Award' AS "__source_type","id","name" FROM "default__award") a0
ORDER BY a0."name" ASC;
```

**Why it fails today:** the alias-defined computed link `winner := Award.<awards[IS User] {...}` is emitted as a multi `json_group_array` array (`COALESCE(...,'[]')`) instead of a single object — its cardinality (single, from `constraint exclusive on awards`) is not honored; nested_03 additionally filters on `.winner.name_upper`, where the same single-vs-array mismatch (plus the `str_upper(.name)` computed in the redefined link's shape) yields the wrong shape.

### computable nested (WITH-binding computed link/field) (3)

- `test_edgeql_computable_nested_01`
- `test_edgeql_computable_nested_02`
- `test_edgeql_computable_nested_03`

A WITH-binding shape introduces a computed link/field (`C := Card { ava_owners := .<avatar }`) that is then re-projected on `C` and decorated with a nested shape, with per-owner aggregates that must correlate to the current owner row.

**Representative:** `test_edgeql_computable_nested_02`

**EdgeQL:**
```edgeql
WITH C := Card { ava_owners := .<avatar }
SELECT C {
    name,
    ava_owners: {
        typename := (
            WITH name := C.ava_owners.__type__.name
            SELECT name
        )
    }
}
FILTER EXISTS .ava_owners
ORDER BY .name;
-- expected: [{"name":"Djinn","ava_owners":[{"typename":"default::Bot"}]}, ...]
```

**Relevant ESDL:**
```edgeql
type User extending Named { avatar: Card { text: str; }; }  -- .<avatar backlinks here
type Bot extending User;
type Card extending Named { ... };
-- ava_owners is introduced ONLY in the WITH-binding shape (not in schema)
```

**Expected SQL (shape of):**
```sql
-- ava_owners must be a resolvable computed link on the binding C:
--   correlated subquery over the avatar junction (backlink), then a nested
--   shape whose `typename` reads the polymorphic __type__.name of each owner.
SELECT a0."id","__source_type", a0."name" AS "name",
  (SELECT json_group_array(json_object(
      'typename', (CASE  -- discriminator of each ava_owner row
                     WHEN o."__source_type"='default::Bot' THEN 'default::Bot'
                     ELSE o."__source_type" END)))
   FROM (<user|bot source>) o
   JOIN "default__user__avatar" aj ON aj."source" = o."id"
   WHERE aj."target" = a0."id") AS "ava_owners"
FROM (<card source>) a0
WHERE EXISTS (SELECT 1 FROM "default__user__avatar" aj WHERE aj."target" = a0."id")
ORDER BY a0."name";
```

**Why it fails today:** a computed link/field introduced in a WITH-binding shape (`C := Card { ava_owners := .<avatar }`) is not visible when `C` is re-projected — compile aborts with `object type 'default::Card' has no link or property 'ava_owners'` (02/03). For `computable_nested_01` the query compiles but the per-owner inner aggregates `fr0 := count(O.friends)` / `fr1 := (WITH F := O.friends SELECT count(F))` are decorrelated: they re-derive the card's owners from scratch and count friends of *all* owners instead of correlating to the current `O` row.

### aliases filter (alias as IN/NOT IN operand) (2)

- `test_edgeql_aliases_filter_01`
- `test_edgeql_aliases_filter02`

The SELECT subject is an alias and that same alias is used as a *whole-object* operand of `IN`/`NOT IN` inside the FILTER (membership against another alias's id set, or against an inline `SELECT Card …` subquery).

**Representative:** `test_edgeql_aliases_filter_01`

**EdgeQL:**
```edgeql
SELECT FireCard { name }
FILTER FireCard IN DaveCard
ORDER BY FireCard.name;
-- expected: [{"name":"Dragon"}]

-- filter02 (same family, NOT IN an inline subquery):
SELECT AirCard {name}
FILTER AirCard NOT IN (SELECT Card FILTER Card.name LIKE 'D%')
ORDER BY AirCard.name;
-- expected: [{"name":"Giant eagle"},{"name":"Sprite"}]
```

**Relevant ESDL:**
```edgeql
alias AirCard  := (SELECT Card FILTER Card.element = 'Air');
alias FireCard := (SELECT Card FILTER Card.element = 'Fire');
alias DaveCard := (SELECT Card FILTER 'Dave' IN Card.<deck[IS User].name);
```

**Expected SQL:**
```sql
-- subject FireCard = (Card WHERE element='Fire'); the FILTER `FireCard IN DaveCard`
-- is an existential membership check of the subject object id against DaveCard's id set.
SELECT a0."id" AS "id", a0."__source_type", a0."name" AS "name"
FROM (SELECT 'default::Card' AS "__source_type","id","name","element" FROM "default__card"
      UNION ALL SELECT 'default::SpecialCard',"id","name","element" FROM "default__specialcard") a0
WHERE (EXISTS (SELECT 1 FROM (SELECT ? AS "value") WHERE "value" = a0."element"))   -- FireCard def
  AND a0."id" IN (
      SELECT d."id" FROM (<card source>) d
      WHERE EXISTS (SELECT 1 FROM "default__user__deck" dj
                    JOIN (<user source>) u ON u."id" = dj."source"
                    WHERE dj."target" = d."id" AND u."name" = 'Dave')   -- DaveCard def
  )
ORDER BY a0."name" ASC;
```

**Why it fails today:** when the SELECT subject is an alias and that same alias (or another object-set alias) is used as a *whole-object* operand of `IN`/`NOT IN` inside the FILTER, the operand fails to resolve — `E_SEMANTIC: object type or alias 'default::FireCard' does not exist` (and identically `'default::AirCard'` for filter02). (`FILTER FireCard.name = …` resolves fine; only the bare-object-set-as-IN-operand form breaks.)

### alias error-message expectations (2)

- `test_edgeql_aliases_backlinks_01`
- `test_edgeql_aliases_helper_01`

These tests assert the compiler *raises* a specific error: following a backlink through a *computed* link, and referencing an internal alias link-helper type by name.

**Representative:** `test_edgeql_aliases_backlinks_01`

**EdgeQL:**
```edgeql
-- backlinks_01: must THROW /cannot follow backlink 'owners'/
SELECT User.<owners[Is Card];

-- helper_01: must THROW /cannot refer to alias link helper type 'default::__AwardAlias2__winner'/
SELECT __AwardAlias2__winner;
```

**Relevant ESDL:**
```edgeql
type Card extending Named { multi owners := .<deck[IS User]; }  -- owners is COMPUTED
alias AwardAlias2 := (SELECT Award { winner := Award.<awards[IS User] { deck: { id } } });
-- the alias's redefined `winner` link materializes a hidden helper type
-- named default::__AwardAlias2__winner that must NOT be user-referenceable
```

**Expected SQL:**
```sql
-- none — must throw at compile time with "cannot follow backlink 'owners'"
--        (helper_01 must throw "cannot refer to alias link helper type 'default::__AwardAlias2__winner'")
```

**Why it fails today:** the engine does not raise. `User.<owners[Is Card]` (a backlink through the *computed* link `owners`) silently compiles to a CROSS JOIN instead of raising `cannot follow backlink 'owners'`. `SELECT __AwardAlias2__winner` compiles as if the internal helper type were a real, user-visible type (`FROM "default____awardalias2__winner"`) instead of raising `cannot refer to alias link helper type …`.

### computable aliased link (1)

- `test_edgeql_computable_aliased_link_01`

An alias renames a link (`my_friends := User.friends`); the nested shape on the renamed link must still surface the underlying `@nickname` link property from the friends junction.

**Representative:** `test_edgeql_computable_aliased_link_01`

**EdgeQL:**
```edgeql
SELECT AliasedFriends {
    my_name,
    my_friends: { @nickname } ORDER BY .name
}
FILTER .name = 'Alice';
-- expected: my_friends each carry @nickname: [{"@nickname":"Swampy"}, ...]
```

**Relevant ESDL:**
```edgeql
type User extending Named {
    multi friends: User { nickname: str; }   -- link property @nickname
}
alias AliasedFriends := (
    SELECT User { my_friends := User.friends, my_name := User.name }
);
```

**Expected SQL:**
```sql
-- my_friends must still expose the @nickname LINK PROPERTY from the underlying
-- friends junction (the alias just renames the link; link-props survive):
SELECT u."id","__source_type", u."name" AS "my_name",
  COALESCE((SELECT json_group_array(json_object(
        'id', t."id", '__source_type', t."__source_type",
        '@nickname', fj."nickname"))               -- <- link prop carried through
     FROM (<user|bot source>) t
     JOIN "default__user__friends" fj ON fj."target" = t."id"
     WHERE fj."source" = u."id"
     ORDER BY t."name" ASC), '[]') AS "my_friends"
FROM (<user|bot source>) u
WHERE EXISTS (SELECT 1 FROM (SELECT ? AS "value") WHERE "value" = u."name");
```

**Why it fails today:** the alias-redefined link `my_friends := User.friends` loses its link-property metadata, so the nested shape emits only `id`/`__source_type` and drops `@nickname` (the `"nickname"` column of `default__user__friends` is never selected).

### aliases basic (named-tuple set alias) (1)

- `test_edgeql_aliases_basic_03`

A schema-level `CREATE ALIAS` over a SET of named tuples is selected and ordered by a tuple field.

**Representative:** `test_edgeql_aliases_basic_03`

**EdgeQL:**
```edgeql
CREATE ALIAS scores := (
    SELECT {
        (name := 'Alice', score := 100, games := 10),
        (name := 'Bob',   score := 11,  games := 2),
        (name := 'Carol', score := 31,  games := 5),
        (name := 'Dave',  score := 78,  games := 10),
    }
);
-- failing assertion:
SELECT scores ORDER BY scores.name;
-- expected: [{name:'Alice',score:100,games:10}, {name:'Bob',...}, ...]
```

**Relevant ESDL:** none — `scores` is a schema-level `CREATE ALIAS` of a SET of named tuples; no object types involved.

**Expected SQL** (alias inlined; one named-tuple json_object per element, ordered by `name`):
```sql
SELECT "value" FROM (
  SELECT json_object('name', n."value", 'score', s."value", 'games', g."value") AS "value"
    FROM (SELECT ? AS "value") n CROSS JOIN (SELECT 100 AS "value") s CROSS JOIN (SELECT 10 AS "value") g
  UNION ALL
  SELECT json_object('name', n."value", 'score', s."value", 'games', g."value") AS "value"
    FROM (SELECT ? AS "value") n CROSS JOIN (SELECT 11 AS "value") s CROSS JOIN (SELECT 2 AS "value") g
  UNION ALL ... -- Carol, Dave
) ORDER BY json_extract("value", '$.name') ASC;
```

**Why it fails today:** result-value mismatch (`expected true to be false`) when a schema-level `CREATE ALIAS` over a set of named tuples is selected and ordered by a tuple field (`ORDER BY scores.name`). The inline `WITH scores := …` equivalent compiles correctly, so the divergence is specific to the `CREATE ALIAS` registration/expansion path for a named-tuple set.

### aliases create (redefined link w/ computed prop) (1)

- `test_edgeql_aliases_create_01`

A `CREATE ALIAS` overrides a link (`owners`) with an expression that adds a nested computed `name_upper := str_upper(.name)` on the link target.

**Representative:** `test_edgeql_aliases_create_01`

**EdgeQL:**
```edgeql
CREATE ALIAS DCard := (
    SELECT Card {
        owners := (
            SELECT Card.<deck[IS User] {
                name_upper := str_upper(.name)
            }
        )
    } FILTER Card.name LIKE 'D%'
);
-- failing assertion:
SELECT DCard {
    name,
    owners: { name_upper } ORDER BY .name
} ORDER BY DCard.name;
-- expected: {"name":"Djinn","owners":[{"name_upper":"CAROL"},{"name_upper":"DAVE"}]}, ...
```

**Relevant ESDL:**
```edgeql
type User extending Named { multi deck: Card { ... }; }
type Card extending Named { multi owners := .<deck[IS User]; }
-- DCard overrides `owners` with an expression that adds a nested computed
-- `name_upper := str_upper(.name)` on the User target
```

**Expected SQL:**
```sql
SELECT c."id","__source_type", c."name" AS "name",
  COALESCE((SELECT json_group_array(json_object(
        'name_upper', upper(u."name")))           -- str_upper(.name) of each owner
     FROM (<user|bot source>) u
     JOIN "default__user__deck" dj ON dj."source" = u."id"
     WHERE dj."target" = c."id"
     ORDER BY u."name" ASC), '[]') AS "owners"
FROM (<card source>) c
WHERE c."name" LIKE 'D%'
ORDER BY c."name" ASC;
```

**Why it fails today:** the nested computed property `name_upper := str_upper(.name)` defined inside the alias's *redefined* `owners` link comes back empty (`''` instead of `'CAROL'`). `.name` inside the redefined link's nested shape is not bound to the link target, so `str_upper(.name)` evaluates over an empty/NULL value (same family as `nested_03`).

### aliases array of array (1)

- `test_edgeql_aliases_array_of_array_02`

An `array<array<Card>>` alias is unpacked twice (`array_unpack` over each cost bucket, then over each Card) and re-aggregated with two levels of `array_agg`, preserving empty inner buckets.

**Representative:** `test_edgeql_aliases_array_of_array_02`

**EdgeQL:**
```edgeql
SELECT array_agg((
    for card_group in array_unpack(AliasCardsByCost)
        select array_agg((
            for card in array_unpack(card_group)
                select card.name
        ))
))
-- expected: [[ [], ["Imp","Dwarf","Sprite"], ["Bog monster","Giant eagle"],
--             ["Giant turtle","Golem"], ["Djinn"], ["Dragon"] ]]
```

**Relevant ESDL:**
```edgeql
alias AliasCardsByCost := array_agg((
    for cost in range_unpack(range(0, max(Card.cost) + 1))
        select array_agg(
            (select Card filter .cost = cost)
        )
));
-- => array<array<Card>>: outer index = cost bucket, inner = cards of that cost
```

**Expected SQL (shape of):** a nested-aggregation pipeline — the alias `AliasCardsByCost` expands to `array_agg` over `range_unpack(range(0, max(cost)+1))` of per-cost `array_agg` of Card object refs; the outer query then `array_unpack`s that (FOR over each cost bucket), `array_unpack`s each bucket (FOR over each Card), projects `card.name`, and re-aggregates with two levels of `json_group_array`, preserving empty inner arrays (cost 0 bucket = `[]`).

**Why it fails today:** the whole nested `array_agg`/`for`/`array_unpack(AliasCardsByCost)` expression compiles to a degenerate `SELECT NULL AS "id", NULL AS "__source_type"` — the array-of-array-of-objects alias, when round-tripped through `array_unpack` (twice) and re-aggregated, produces no valid source. (The simpler `array_of_array_01`, `select AliasArrayOfArrayOfScalar`, passes for an array-of-array of *scalars*.)

### aliases introspection (1)

- `test_edgeql_aliases_introspection`

Introspection metadata for aliases: the `schema::Type.from_alias` flag, `schema::Tuple`/`TupleElement` rows for tuple-typed aliases, and alias link-helper target types.

**Representative:** `test_edgeql_aliases_introspection`

**EdgeQL:**
```edgeql
-- part 2 (the load-bearing one): tuple alias element types in order
CREATE ALIAS tuple_alias := ('foo', 10);
WITH MODULE schema
SELECT Tuple {
    name,
    element_types: { name := .type.name } ORDER BY @index
}
FILTER .from_alias AND .name = 'default::tuple_alias'
ORDER BY .name;
-- expected: {name:'default::tuple_alias',
--            element_types:[{name:'std::str'},{name:'std::int64'}]}

-- part 3: pointer's target is an alias helper type
select schema::Pointer { name, target: { from_alias } }
filter .name = 'winner' and .source.name = 'default::AwardAlias';
-- expected: {name:'winner', target:{from_alias:true}}
```

**Relevant ESDL:**
```edgeql
alias AwardAlias := (Award { winner := Award.<awards[IS User] { name_upper := ... } });
-- requires: schema::Type.from_alias flag set for AirCard/AwardAlias/helper types;
--           schema::Tuple + schema::TupleElement rows for tuple-typed aliases;
--           the alias link target (__AwardAlias__winner helper) marked from_alias=true
```

**Expected SQL:** the queries already lower to plausible SQL over `schema__type`, `schema__tuple`, `schema__tupleelement`, `schema__pointer`; correctness depends on the introspection tables being *populated* for aliases.

**Why it fails today:** alias introspection metadata is incomplete. `element_types: { name := .type.name }` projects `NULL AS "name_id"` (the TupleElement→type→name chain is not resolved), and the `from_alias` flag / `schema::Tuple`/`TupleElement` rows / alias link-helper target types are not populated for `CREATE ALIAS`-created aliases — so the introspection rows the test expects are missing/empty. (This is a schema-metadata population gap, not a pure SQL-shape bug.)


---

## tests/edgeql_linkatoms.test.ts (15)

In this engine's physical layout the `multi property tag_set1`/`tag_set2` values are
stored as a JSON array in a column on the object table (`default__item."tag_set1"`),
read element-wise via `json_each(COALESCE(a0."tag_set1", '[]'))`. `tag_array` is a
plain `array<str>` stored as a JSON column (`a0."tag_array"`). The failing cluster is
*derived* values built from these multi-property sources: array/tuple constructors over
several multi props (which yield a **set of arrays/tuples** via cartesian expansion),
then indexed/sliced/element-projected, plus cross-item self-referential `NOT IN`/
`NOT EXISTS` filters over those sets.

| Count | Query group | Pattern |
|---:|---|---|
| 7 | Indexed/sliced array over multi-property sources | `[Item.tag_set1, Item.tag_set2][i]`, `[...][{0,1}]`, `[...][1:20]` — index/slice of an array built from multiple multi props |
| 3 | Cross-item self-referential set difference | `WITH I2 := Item ... FILTER _ NOT IN ((SELECT I2 FILTER I2 != Item).tag_set1)` |
| 3 | Cross-item self-referential array difference | `WITH I2 := Item ... array_unpack(Item.tag_array) NOT IN / NOT EXISTS over other items` |
| 1 | Tuple-element projection over multi-property sources | `(Item.tag_set1,).0`, `(Item.tag_set1, Item.tag_set2).1` |
| 1 | Element-wise `re_match` over two multi properties | `re_match(Item.tag_set1, Item.tag_set2)` |

### Indexed/sliced array over multi-property sources (7)

- `test_edgeql_links_derived_array_01`
- `test_edgeql_links_derived_array_02`
- `test_edgeql_links_derived_array_03`
- `test_edgeql_links_derived_array_04`
- `test_edgeql_links_derived_array_05`
- `test_edgeql_links_derived_array_06`
- `test_edgeql_links_derived_array_07`

**Representative:** `test_edgeql_links_derived_array_06`

**EdgeQL:**
```edgeql
SELECT Item {
    name,
    a_a1 := Item.tag_array[1:20],
    a_t2 := [Item.tag_set1, Item.tag_set2][1:20],
}
FILTER .name IN {'ball', 'chair', 'table'}
ORDER BY .name;
```

The distinguishing operand is `[Item.tag_set1, Item.tag_set2]`: an array constructor
over two *multi* props. Per Gel semantics this is a **set** of arrays — one per element
of the cartesian product of the two sets. Slicing/indexing then applies element-wise to
each array in that set. (`derived_array_01/02` use `[...][1]`/`array_get([...],1)`,
`03/04/05` use a set index `[...][{0,1}]`/`array_get(...,{0,1})`, `06/07` slice `[1:20]`/
`[{1,2}:20]`. The single-source `Item.tag_array[...]` half of each test already works.)

**Relevant ESDL:**
```esdl
type Item extending Named {
    multi property tag_set1 -> str;
    multi property tag_set2 -> str;
    property tag_array -> array<str>;
}
```

**Expected SQL:** the multi-source array must first be materialized as a set of arrays
(cartesian product of the two `json_each` sources), then each array sliced, then the
slices grouped back into the result set. Modeled on the working single-source slice idiom
(`a_a1` already compiles as `json_extract`/`json_each`-over-`a0."tag_array"`):

```sql
SELECT
  a0."id" AS "id",
  a0."__source_type" AS "__source_type",
  a0."name" AS "name",
  -- a_a1: single stored array, slice [1:20] (this half already compiles)
  (SELECT CASE WHEN b IS NULL THEN NULL
               ELSE COALESCE((SELECT json_group_array("value") FROM json_each(b)
                              WHERE "key" >= 1 AND "key" < 20), '[]') END
   FROM (SELECT a0."tag_array" AS b)) AS "a_a1",
  -- a_t2: array built from two multi props -> SET of arrays, each sliced [1:20]
  COALESCE((
    SELECT json_group_array(json(sliced))
    FROM (
      SELECT COALESCE((SELECT json_group_array(je2."value")
                       FROM json_each(arr) je2
                       WHERE je2."key" >= 1 AND je2."key" < 20), '[]') AS sliced
      FROM (
        SELECT json_array(arr_0."value", arr_1."value") AS arr
        FROM (SELECT je."value" AS "value" FROM json_each(COALESCE(a0."tag_set1", '[]')) je) arr_0
        CROSS JOIN (SELECT je."value" AS "value" FROM json_each(COALESCE(a0."tag_set2", '[]')) je) arr_1
        ORDER BY arr_0."value", arr_1."value"
      )
    )
  ), '[]') AS "a_t2"
FROM (SELECT 'default::Item' AS "__source_type", "id" AS "id", "name" AS "name",
             "tag_set1" AS "tag_set1", "tag_set2" AS "tag_set2", "tag_array" AS "tag_array"
      FROM "default__item") a0
WHERE (a0."name" IN (?, ?, ?))
ORDER BY a0."name" ASC
```

**Why it fails today:** the index/slice operator only handles a single stored array
operand; when the array operand is a constructor over multi props (a *set* of arrays),
the compiler silently **drops the entire shape field** — `bin/inspect.ts sql` shows the
`a_t2`/`t4` column missing from the SELECT list entirely (no per-element index/slice over
the cartesian-expanded set, and no result ordering).

### Cross-item self-referential set difference (3)

- `test_edgeql_links_set_12`
- `test_edgeql_links_set_13`
- `test_edgeql_links_set_14`

**Representative:** `test_edgeql_links_set_12`

**EdgeQL:**
```edgeql
WITH
    I2 := Item
SELECT Item {
    name,
    unique := (
        SELECT _ := Item.tag_set1
        FILTER _ NOT IN (
            (SELECT I2 FILTER I2 != Item).tag_set1
        )
    )
}
ORDER BY .name;
```

`set_13` wraps the same `unique` subexpression in `count(...)` and filters `.unique > 0`;
`set_14` filters `count(.unique) > 0`. All three share the correlated other-items
subquery.

**Relevant ESDL:**
```esdl
type Item extending Named {
    multi property tag_set1 -> str;
}
```

**Expected SQL:** `(SELECT I2 FILTER I2 != Item).tag_set1` is the union of every *other*
item's `tag_set1` set; `unique` keeps the tags of the current item not present there.

```sql
SELECT
  a0."id" AS "id",
  a0."__source_type" AS "__source_type",
  a0."name" AS "name",
  COALESCE((
    SELECT json_group_array("value")
    FROM (
      SELECT je."value" AS "value"
      FROM json_each(COALESCE(a0."tag_set1", '[]')) je
      WHERE je."value" NOT IN (
        -- tags belonging to every OTHER item (I2 != Item), unpacked element-wise
        SELECT je2."value"
        FROM "default__item" a1
        CROSS JOIN json_each(COALESCE(a1."tag_set1", '[]')) je2
        WHERE a1."id" <> a0."id"
      )
    )
  ), '[]') AS "unique"
FROM (SELECT 'default::Item' AS "__source_type", "id" AS "id", "name" AS "name",
             "tag_set1" AS "tag_set1" FROM "default__item") a0
ORDER BY a0."name" ASC
```

**Why it fails today:** the `NOT IN` right side compiles to
`NOT IN (SELECT a0."tag_set1")` — it references the *current* item's whole `tag_set1`
JSON column, never joining in the other items (`SELECT I2 FILTER I2 != Item` is lost) and
never `json_each`-unpacking the set. So nothing is ever excluded, giving wrong/over-large
`unique` sets (set_12 yields count 2 where 1 is expected).

### Cross-item self-referential array difference (3)

- `test_edgeql_links_array_09`
- `test_edgeql_links_array_10`
- `test_edgeql_links_array_11`

**Representative:** `test_edgeql_links_array_09`

**EdgeQL:**
```edgeql
WITH
    I2 := Item
SELECT Item {
    name,
    unique := (
        SELECT _ := array_unpack(Item.tag_array)
        FILTER _ NOT IN (
            SELECT array_unpack(
                (SELECT I2 FILTER I2 != Item).tag_array
            )
        )
    )
}
ORDER BY .name;
```

`array_10` adds `FILTER count(.unique) > 0`; `array_11` is the `NOT EXISTS` dual:
`FILTER EXISTS Item.tag_array AND NOT EXISTS (SELECT I2 FILTER I2 != Item AND
array_unpack(I2.tag_array) = array_unpack(Item.tag_array))`. Same correlated-other-items
root, over `array_unpack(tag_array)` instead of `tag_set1`.

**Relevant ESDL:**
```esdl
type Item extending Named {
    property tag_array -> array<str>;
}
```

**Expected SQL:** unpack the current item's `tag_array`, exclude any element appearing in
the unpacked `tag_array` of any other item.

```sql
SELECT
  a0."id" AS "id",
  a0."__source_type" AS "__source_type",
  a0."name" AS "name",
  COALESCE((
    SELECT json_group_array("value")
    FROM (
      SELECT je."value" AS "value"
      FROM json_each(COALESCE(a0."tag_array", '[]')) je
      WHERE je."value" NOT IN (
        SELECT je2."value"
        FROM "default__item" a1
        CROSS JOIN json_each(COALESCE(a1."tag_array", '[]')) je2
        WHERE a1."id" <> a0."id"
      )
    )
  ), '[]') AS "unique"
FROM (SELECT 'default::Item' AS "__source_type", "id" AS "id", "name" AS "name",
             "tag_array" AS "tag_array" FROM "default__item") a0
ORDER BY a0."name" ASC
```

**Why it fails today:** the inner `FILTER _ NOT IN (SELECT array_unpack((SELECT I2
FILTER I2 != Item).tag_array))` is **dropped entirely** — `unique` compiles to a plain
`json_each` of the item's own `tag_array` with no `WHERE`, so every item keeps all its
tags (array_11's whole `FILTER ... NOT EXISTS (...)` likewise vanishes, returning all
items). The correlated cross-item subquery feeding `NOT IN`/`NOT EXISTS` over an
`array_unpack` set is not lowered.

### Tuple-element projection over multi-property sources (1)

- `test_edgeql_links_derived_tuple_01`

**Representative:** `test_edgeql_links_derived_tuple_01`

**EdgeQL:**
```edgeql
SELECT Item {
    n1 := (Item.name,),
    n2 := (Item.name,).0,
    t1 := (Item.tag_set1,),
    t2 := (Item.tag_set1, Item.tag_set2),
    t3 := (Item.tag_set1,).0,
    t4 := (Item.tag_set1, Item.tag_set2).1,
}
FILTER .name IN {'chair', 'table'}
ORDER BY .name;
```

The two broken fields are the `.N` projections out of a tuple built from multi props:
`t3 := (Item.tag_set1,).0` and `t4 := (Item.tag_set1, Item.tag_set2).1`. (The whole-tuple
fields `t1`/`t2` already produce correct cartesian-expanded sets.)

**Relevant ESDL:**
```esdl
type Item extending Named {
    multi property tag_set1 -> str;
    multi property tag_set2 -> str;
}
```

**Expected SQL:** building the tuple cartesian-expands the multi sources into a set of
tuples; `.0`/`.1` then projects one element from each tuple in that set, preserving
multiplicity and result ordering. For `table`, `t4 := (tag_set1, tag_set2).1` must yield
all four `tag_set2` components of the 2x2 product, sorted:
`["rectangle","rectangle","wood","wood"]`.

```sql
SELECT
  ...,
  -- t3 := (tag_set1,).0  -> just the tag_set1 set, ordered
  COALESCE((SELECT json_group_array("value")
            FROM (SELECT je."value" AS "value"
                  FROM json_each(COALESCE(a0."tag_set1", '[]')) je
                  ORDER BY je."value")), '[]') AS "t3",
  -- t4 := (tag_set1, tag_set2).1 -> 2nd component of each tuple in the cartesian set
  COALESCE((SELECT json_group_array("value")
            FROM (SELECT je1."value" AS "value"
                  FROM json_each(COALESCE(a0."tag_set1", '[]')) je0
                  CROSS JOIN json_each(COALESCE(a0."tag_set2", '[]')) je1
                  ORDER BY je0."value", je1."value")), '[]') AS "t4"
FROM (SELECT 'default::Item' AS "__source_type", "id" AS "id", "name" AS "name",
             "tag_set1" AS "tag_set1", "tag_set2" AS "tag_set2" FROM "default__item") a0
WHERE (a0."name" IN (?, ?))
ORDER BY a0."name" ASC
```

**Why it fails today:** `.N` projection over a multi-sourced tuple set loses cartesian
multiplicity and ordering. For `table`, `t4` returns `["wood","rectangle"]` (the distinct
tag_set2 values, unsorted) instead of the full 4-element ordered product
`["rectangle","rectangle","wood","wood"]`; `t3` returns `["wood","rectangle"]` instead of
the sorted `["rectangle","wood"]`.

### Element-wise `re_match` over two multi properties (1)

- `test_edgeql_links_derived_array_08`

**Representative:** `test_edgeql_links_derived_array_08`

**EdgeQL:**
```edgeql
SELECT Item {
    name,
    re := re_match(Item.tag_set1, Item.tag_set2),
}
FILTER .name IN {'chair', 'table'}
ORDER BY .name;
```

`re_match(pattern, string)` is called element-wise over the cartesian product of the two
multi sets; each call returns `array<str>` (or the **empty set** on no match). For
`table` the only matches are where a tag equals itself (`rectangle`~`rectangle`,
`wood`~`wood`), giving `[["rectangle"],["wood"]]`.

**Relevant ESDL:**
```esdl
type Item extending Named {
    multi property tag_set1 -> str;
    multi property tag_set2 -> str;
}
```

**Expected SQL:** cross-join the two unpacked sets, call `re_match` per pair, and **drop
pairs with no match** (empty set, not null), ordered:

```sql
SELECT
  a0."id" AS "id",
  a0."__source_type" AS "__source_type",
  a0."name" AS "name",
  COALESCE((
    SELECT json_group_array(json("value"))
    FROM (
      SELECT _gel_re_match_first(jem0."value", jem1."value") AS "value"
      FROM json_each(COALESCE(a0."tag_set1", '[]')) jem0
      CROSS JOIN json_each(COALESCE(a0."tag_set2", '[]')) jem1
      WHERE _gel_re_match_first(jem0."value", jem1."value") IS NOT NULL  -- drop non-matches
      ORDER BY jem0."value", jem1."value"
    )
  ), '[]') AS "re"
FROM (SELECT 'default::Item' AS "__source_type", "id" AS "id", "name" AS "name",
             "tag_set1" AS "tag_set1", "tag_set2" AS "tag_set2" FROM "default__item") a0
WHERE (a0."name" IN (?, ?))
ORDER BY a0."name" ASC
```

**Why it fails today:** the lowering keeps every cartesian pair and emits `null` for
non-matching pairs instead of eliminating them (re_match returns an *empty set*, not
null), and the result is unordered. For `table` it produces
`[["wood"],null,null,["rectangle"]]` instead of `[["rectangle"],["wood"]]` — wrong length,
stray nulls, wrong order.


---

## tests/edgeql_filter.test.ts (4)

Schema: `tests/schemas/issues.esdl` (`--schema issues`). Setup: `issues_filter_setup`.
Relevant types: `User extending Dictionary` (has `name`); `Issue extending Named, Owned, Text`
with `required owner: User` (overloaded, carries link prop `since` → junction storage),
`optional time_estimate: int64`, `due_date: datetime`, `required number: issue_num_t`, and
`required status: Status`. The backlink `User.<owner[IS Issue]` is the set of Issues a user owns
(junction table `default__issue__owner`). `Status` has `name`.

| Count | Query group | Pattern |
|---:|---|---|
| 2 | Existential AND of two scalar conditions over a backlink | `any(FOR i IN User.<owner[IS Issue] SELECT cond1 AND cond2)` / `EXISTS … AND (FOR … = …)` |
| 1 | Cross product after a filtered subquery | `(SELECT Issue FILTER …).number ++ Status.name` |
| 1 | Self-comparison of object set inside a sub-FILTER | `FILTER I = U2.<owner[IS Issue]` where `I := User.<owner[IS Issue]` |

### Existential AND of two scalar conditions over a backlink (2)

- `test_edgeql_filter_two_scalar_conditions01`
- `test_edgeql_filter_not_exists04`

Find Users who own at least one Issue satisfying two scalar predicates simultaneously, where the
conjunction is expressed not with the simple `EXISTS(SELECT … FILTER c1 AND c2)` form but with an
`any(FOR …)` body (conditions01) or an `EXISTS … AND (FOR …)` mix of a `NOT EXISTS` scalar test and
an object-identity self-join (not_exists04). Both must lower to a single existential over the backlink.

**Representative:** `test_edgeql_filter_two_scalar_conditions01`

**EdgeQL:**
```edgeql
# Find Users who own at least one Issue with simultaneously
# time_estimate > 9000 and due_date on 2020/01/15.
SELECT User{name}
FILTER
    any((
      for issue in User.<owner[IS Issue]
      select issue.time_estimate > 9000
      AND
      issue.due_date = <datetime>'2020-01-15T00:00:00+00:00'
    ))
ORDER BY User.name;
```

**ESDL:**
```esdl
type User extending Dictionary;          # has required name: str
abstract type Owned { required owner: User { note: str; } }
type Issue extending Named, Owned, Text {
    overloaded required link owner { property since: datetime; }
    optional time_estimate: int64;
    due_date: datetime;
}
# User.<owner[IS Issue]  -> backlink over junction table default__issue__owner
```

**Expected SQL:** (the `any(FOR … SELECT c1 AND c2)` form must lower to the same existential-over-backlink
shape the passing sibling `two_scalar_exists01` already produces — an `EXISTS` correlated subquery joining
the owner junction to the Issue table and ANDing both element-wise scalar predicates)
```sql
SELECT a0."id" AS "id", a0."__source_type" AS "__source_type", a0."name" AS "name"
FROM (SELECT 'default::User' AS "__source_type", "id" AS "id", "name" AS "name"
      FROM "default__user") a0
WHERE EXISTS (
    SELECT 1
    FROM "default__issue__owner" _lj0
    JOIN (SELECT 'default::Issue' AS "__source_type", "id" AS "id",
                 "time_estimate" AS "time_estimate", "due_date" AS "due_date"
          FROM "default__issue") _ex0
      ON _ex0."id" = _lj0."source"
    WHERE _lj0."target" = a0."id"
      AND ( (_ex0."time_estimate" > 9000)
            AND
            (_ex0."due_date" = ?) )      -- ? = <datetime>'2020-01-15T00:00:00+00:00'
)
ORDER BY a0."name" ASC
```
(`not_exists04` is the same family: `EXISTS User.<owner[IS Issue] AND (FOR lol IN U2.<owner[IS Issue] SELECT NOT EXISTS lol.time_estimate AND User.<owner[IS Issue] = lol)` — an existential over the backlink combining a `NOT EXISTS` scalar test with an object-identity self-join; expected to lower to an `EXISTS` correlating the two backlink roots on `id`.)

**Why it fails today:** the `any(...)`/`FOR`-over-backlink form is not lowered to the element-wise
`EXISTS … AND …` shape — the AND of the two scalar conditions collapses to a plain "owns any Issue"
test, so conditions01 returns 3 users instead of 1 (Yury) and not_exists04 returns 3 instead of 2
(Elvis, Yury). The passing `EXISTS(SELECT FILTER c1 AND c2)` sibling proves the correct idiom exists.

### Cross product after a filtered subquery (1)

- `test_edgeql_filter_flow03`

The interaction of FILTER with a cross product: the left operand of the `++` string concatenation is
a *filtered* Issue subquery, cross-joined against the full `Status` set. The first sub-assertion (the
unfiltered baseline) passes; the failing sub-assertions wrap the Issue source in `(SELECT Issue FILTER
Issue.owner.name = 'Elvis')` before the cross product.

**Representative:** `test_edgeql_filter_flow03` (second/third sub-assertions)

**EdgeQL:**
```edgeql
# interaction of filter and cross product (expects 4 rows)
SELECT _ := (
        SELECT Issue
        FILTER Issue.owner.name = 'Elvis'
    ).number ++ Status.name
ORDER BY _;
```

**ESDL:**
```esdl
type Issue extending Named, Owned, Text { required number: issue_num_t; }
abstract type Owned { required owner: User { note: str; } }   # owner.name via default__issue__owner
type Status extending Dictionary;                              # has name
```

**Expected SQL:** (a CROSS JOIN of the *filtered* Issue source against the Status source, concatenating
`number ++ name`. The unfiltered baseline already compiles to `(a0."number" || a1."name")` over a CROSS
JOIN, so the filtered subquery must remain a row source on the left of the same CROSS JOIN.)
```sql
SELECT "value" AS "value"
FROM (
  SELECT (a0."number" || a1."name") AS "value"
  FROM (
        SELECT a2."number" AS "number"
        FROM (SELECT 'default::Issue' AS "__source_type", "id", "number" FROM "default__issue") a2
        JOIN "default__issue__owner" aJ ON aJ."source" = a2."id"
        JOIN (SELECT "id","name" FROM "default__user") aU ON aU."id" = aJ."target"
        WHERE aU."name" = 'Elvis'
       ) a0
  CROSS JOIN (SELECT 'default::Status' AS "__source_type", "id", "name" FROM "default__status") a1
) WHERE "value" IS NOT NULL
ORDER BY "value" ASC
```

**Why it fails today:** `(SELECT Issue FILTER …).number ++ Status.name` compiles to a degenerate
`SELECT NULL AS "id", NULL AS "__source_type"` — the filtered-subquery left operand of the `++` cross
product is dropped entirely, so the query returns 1 NULL row instead of 4. (Sibling `filter_flow02`,
the foreign-extent FILTER case, was already fixed; this cross-product-after-filtered-subquery variant
still produces the degenerate plan.)

### Self-comparison of object set inside a sub-FILTER (1)

- `test_edgeql_filter_two_scalar_exists04`

An `EXISTS` over the backlink whose inner FILTER nests a *second* backlink subquery
(`SELECT U2.<owner[IS Issue] FILTER I = U2.<owner[IS Issue]`) and compares it for object identity
against the outer bound set `I`. The identity equality must correlate the two backlink roots on `id`.

**Representative:** `test_edgeql_filter_two_scalar_exists04`

**EdgeQL:**
```edgeql
WITH U2 := User
SELECT User{name}
FILTER
    EXISTS (
        SELECT I := User.<owner[IS Issue]
        FILTER
            NOT (
                NOT EXISTS I.time_estimate OR
                NOT EXISTS (
                    (SELECT U2.<owner[IS Issue]
                     FILTER I = U2.<owner[IS Issue]).due_date
                )
            )
    )
ORDER BY User.name;
```

**ESDL:**
```esdl
type User extending Dictionary;
type Issue extending Named, Owned, Text { optional time_estimate: int64; due_date: datetime; }
# I := User.<owner[IS Issue] ; U2 := User ; comparison I = U2.<owner[IS Issue] is object identity
```

**Expected SQL:** (the inner `SELECT U2.<owner[IS Issue] FILTER I = U2.<owner[IS Issue]` is an
object-identity self-join: correlate the inner Issue backlink to the outer `I` on `id` and project
`due_date`. Expected to lower to a nested `EXISTS` whose inner source filters the second backlink root
to the rows whose `id` equals the outer `I."id"`.)
```sql
-- … outer EXISTS over User.<owner[IS Issue] as _ex0 (= I) …
-- inner: SELECT 1 FROM default__issue__owner _lj1
--        JOIN default__issue _ex1 ON _ex1."id" = _lj1."source"
--        WHERE _lj1."target" = a0."id"          -- U2.<owner[IS Issue]
--          AND _ex1."id" = _ex0."id"             -- I = U2.<owner[IS Issue]  (object identity)
--          AND _ex1."due_date" IS NOT NULL
-- no single flat SQL — nested correlated EXISTS with an object-identity equality
```

**Why it fails today:** raises `operator '=' cannot be applied to operands of type 'I' and 'Issue'` —
the equality between the bound set `I` (alias of `User.<owner[IS Issue]`) and another object-set path
`U2.<owner[IS Issue]` is not recognized as object-identity comparison, so the sub-FILTER never type-checks.


---

## tests/edgeql_userddl.test.ts (2)

Schema is defined inline via DDL inside each test (`h.script("CREATE …")`), not from an `.esdl` file.

| Count | Query group | Pattern |
|---:|---|---|
| 1 | UDF call distributed over a multi-set argument | `count(func_20({'q','w'}))` where `func_20 -> SET OF str` |
| 1 | START / POPULATE / COMMIT MIGRATION session | DDL migration block + `sys::ExtensionPackage` |

### UDF call distributed over a multi-set argument (1)

- `test_edgeql_userddl_20`

**Representative:** `test_edgeql_userddl_20`

**EdgeQL / DDL:**
```edgeql
CREATE FUNCTION func_20(a: str) -> SET OF str
    USING EdgeQL $$
        SELECT {a, 'a'}
    $$;

SELECT func_20('q');                  -- expects {'q','a'}        (PASSES)
SELECT count(func_20({'q', 'w'}));    -- expects 4                (FAILS: gets 1)
```

**Relevant DDL:** (inline; no `.esdl`) — a SET-OF EdgeQL function whose body is `SELECT {a, 'a'}`.
Called element-wise on the 2-element set `{'q','w'}` it must yield
`{q,a} ∪ {w,a}` = 4 elements (sets are not de-duplicated across the FOR-distribution here).

**Expected SQL:** The multi-set argument must be distributed element-wise: the inlined UDF body is
evaluated once per input element and the per-element result sets are UNION-ALL'd, then counted
(matching the `count(<set>)` idiom `SELECT (SELECT count(*) FROM (<set source>)) AS "value"`).
```sql
SELECT (
  SELECT count(*) FROM (
    -- element-wise distribution of {'q','w'} through SELECT {a,'a'}
    SELECT ? AS "value"  UNION ALL SELECT 'a' AS "value"   -- a='q' -> {q,a}
    UNION ALL
    SELECT ? AS "value"  UNION ALL SELECT 'a' AS "value"   -- a='w' -> {w,a}
  )
) AS "value"
```
Compare the (mis-)compiled idiom observed for a single-return UDF, which already shows the bug shape:
`count(ident({'q','w'}))` emits
`SELECT count((SELECT json_group_array("value") FROM (SELECT ? UNION ALL SELECT ?))) AS "value"` —
it aggregates the whole argument set into ONE json array and counts that single value (= 1).

**Why it fails today:** UDF calls over a multi-set argument are not distributed per element — the
argument set is collapsed into a single `json_group_array` (one value), so `count(func_20({'q','w'}))`
returns 1 instead of 4. The single-arg call `func_20('q')` works because there is no set to distribute.

### START / POPULATE / COMMIT MIGRATION session (1)

- `test_edgeql_userddl_all_extensions_01`

**Representative:** `test_edgeql_userddl_all_extensions_01`

**EdgeQL / DDL:**
```edgeql
SELECT DISTINCT sys::ExtensionPackage.name;     -- enumerate available extensions

START MIGRATION TO {
    using future warn_old_scoping;
    using extension <ext>;          -- one per installed extension
    module default { }
};
POPULATE MIGRATION;
COMMIT MIGRATION;
-- … repeated several times, toggling `using future warn_old_scoping;` and the
--    set of `using extension …` lines, plus:
DESCRIBE CURRENT DATABASE CONFIG AS DDL;
DESCRIBE INSTANCE CONFIG AS DDL;
```

**Relevant DDL:** none in an `.esdl` — the test drives the migration *session* state machine and the
`sys::ExtensionPackage` system catalog.

**Expected SQL:** No single SQL — this is a DDL / migration-session runtime path. Expected behavior is
that the engine implements the migration session statements (`START MIGRATION TO { … }`,
`POPULATE MIGRATION`, `COMMIT MIGRATION`), the `using future warn_old_scoping` future flag, and
`using extension …` so the block applies the target schema (here effectively a no-op `module default {}`
with extensions toggled), and that `sys::ExtensionPackage.name` enumerates the extension packages.

**Why it fails today:** sqlite-ts has no migration-session machinery — `START MIGRATION` /
`POPULATE MIGRATION` / `COMMIT MIGRATION` (and the `using future` / `using extension` toggles inside the
migration block) are unimplemented, so the script throws. Left as a parity placeholder.


---

## tests/dump01.test.ts (1)

Schema: `tests/schemas/dump01_test.esdl` (`--schema dump01_test`), which the harness composes from
`dump01_default.esdl` (module `default`, where C/D/E/F live) + `dump01_test.esdl` (module `test`).
Setup: `dump01_setup` (inserts D #0–3, E #4–7, F #8). This is the dump/restore round-trip validation
of the `D` link data.

| Count | Query group | Pattern |
|---:|---|---|
| 1 | Polymorphic base-type shape with per-subtype-overloaded links | `SELECT D { single_link {…}, multi_link {…} } FILTER .__type__.name = 'default::D'` |

(one row per group; the Count column sums to 1)

### Polymorphic base-type shape with per-subtype-overloaded links (1)

- `should validate D link data`

`SELECT D` is polymorphic over the concrete set `{D, E, F}` (E and F extend D). The shape projects the
single `single_link` and the multi `multi_link` (both to `C`), and the `FILTER .__type__.name =
'default::D'` should restrict the result to the four D instances only. The complication: E *overloads*
both links, adding link properties (`lp0`/`lp1`), so the per-subtype physical layouts differ.

**Representative:** `should validate D link data`

**EdgeQL:**
```edgeql
SELECT D {
  num,
  single_link {
    val,
  },
  multi_link {
    val,
  } ORDER BY .val,
}
FILTER .__type__.name = 'default::D'
ORDER BY .num;
```

**ESDL:**
```esdl
type C { required property val -> str { constraint exclusive } }

type D {
    required property num -> int64;
    link single_link -> C { annotation title := 'single link to C' };       # single
    multi link multi_link -> C { annotation title := 'multi link to C' };    # multi
}
type E extending D {                  # OVERLOADS the links, adding link properties
    overloaded link single_link -> C { property lp0 -> str };
    overloaded multi link multi_link -> C { property lp1 -> str };
}
type F extending D {                  # OVERLOADS the links as required
    overloaded required link single_link -> C;
    overloaded required multi link multi_link -> C;
}
```

**Expected SQL:** a `UNION ALL` over the concrete subtypes (D, E, F), each branch projecting the **same
column set and arity** (so the link-property columns E adds must appear as `NULL` placeholders in the D
and F branches), then the `__type__` filter prunes to `'default::D'`, then the shape sub-selects join
each link's junction table to the `C` target for `val`. By analogy to the passing single-link +
multi-link shape idiom:
```sql
SELECT a0."id" AS "id", a0."__source_type" AS "__source_type", a0."num" AS "num",
       -- single_link (single -> json_extract($[0])):
       json(COALESCE(json_extract(COALESCE((
         SELECT json_group_array(json("item")) FROM (
           SELECT json_object('id', a1."id", '__source_type', a1."__source_type", 'val', a1."val") AS "item"
           FROM (SELECT 'default::C' AS "__source_type", "id", "val" FROM "default__c") a1
           JOIN "default__d__single_link" a2 ON a2."target" = a1."id"
           WHERE a2."source" = a0."id" ORDER BY a2."rowid")), '[]'), '$[0]'), 'null')) AS "single_link",
       -- multi_link (multi -> json array, ORDER BY .val):
       COALESCE((
         SELECT json_group_array(json("item")) FROM (
           SELECT json_object('id', a1."id", '__source_type', a1."__source_type", 'val', a1."val") AS "item"
           FROM (SELECT 'default::C' AS "__source_type", "id", "val" FROM "default__c") a1
           JOIN "default__d__multi_link" a3 ON a3."target" = a1."id"
           WHERE a3."source" = a0."id" ORDER BY a1."val")), '[]') AS "multi_link"
FROM (
   -- polymorphic union: ALL branches MUST have identical column arity
   SELECT 'default::D' AS "__source_type", "id", "num", NULL AS "single_lp0", NULL AS "multi_lp1" FROM "default__d"
   UNION ALL
   SELECT 'default::E' AS "__source_type", "id", "num",  … ,  …  FROM "default__e"
   UNION ALL
   SELECT 'default::F' AS "__source_type", "id", "num", NULL, NULL FROM "default__f"
) a0
WHERE a0."__source_type" = 'default::D'        -- .__type__.name = 'default::D'
ORDER BY a0."num" ASC
```
(The sibling tests `should validate E link data` and `should validate F link data` — each selecting a
single concrete type — PASS, confirming the per-link shape/junction idiom above is correct; only the
polymorphic base-type union is broken.)

**Why it fails today:** prepare-time error
`SELECTs to the left and right of UNION ALL do not have the same number of result columns`. The
polymorphic `SELECT D` builds a `UNION ALL` over `{D, E, F}` but emits a *different column count per
branch* — E's overloaded links carry link-property columns (`lp0`/`lp1`) that the D and F branches do
not project, and those extra columns are not back-filled as `NULL` placeholders to equalize arity.
Compounding it, the `.__type__.name = 'default::D'` predicate is applied *after* the union rather than
pruning the E/F branches up front, so the mismatched-arity union is still constructed and fails when
SQLite prepares it.


---

