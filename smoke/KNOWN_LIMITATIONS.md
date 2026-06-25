# D1 / Durable Objects: known semantic differences

The D1 and Durable Objects backends (`target: "d1"`) are a **SQLite-native**
target, not a bit-exact Gel emulation. Cloudflare D1 and DO SQL storage cannot
register custom functions, so where Gel's exact semantics depend on the
`_gel_*` custom functions, the D1/DO target lowers to the equivalent **native
SQLite** function instead. For valid inputs the results match Gel; the
differences below are on edge cases, and are accepted in exchange for the
function running at all (the alternative is `no such function: _gel_*`).

The default **better-sqlite3 backend (`target: "sqlite"`) is unaffected** — it
keeps the `_gel_*` functions and remains bit-exact with Gel. These differences
apply only when running on D1 / Durable Objects.

## Numeric

| Function | Gel | D1 / DO (native SQLite) |
|---|---|---|
| `math::sin/cos/tan/asin/acos/ln/lg/log/exp/sqrt/cot` | throws on out-of-domain / non-finite input | returns `NULL` (SQLite domain behaviour) |
| `math::round` | banker's rounding (half to **even**) — `round(2.5) = 2` | half **away from zero** — `round(2.5) = 3` |
| `math::mean` | exact | native `avg` (identical for valid input; `NULL` over the empty set instead of raising) |
| `//` (floor div), `%` (mod) | floored (sign of divisor); raises on division by zero | native `floor()`-based — **values match exactly, including negatives**; division by zero yields `NULL` instead of raising. (`//` result is float-typed.) |
| `math::var`, `var_pop`, `stddev`, `stddev_pop` | numerically-stable; raises on empty / single-element | reimplemented via `avg`/`sum` (`var_pop = E[x²]−E[x]²`): correct to within float **ULPs**; `NULL` (not raise) over empty set or single element |

## Datetime

`std::datetime_get`, `cal::date_get`, `cal::time_get` lower to native
`strftime`:

- **Sub-second units** (`seconds`, `milliseconds`, `microseconds`) are
  **millisecond-precision** (SQLite `strftime('%f')`), not Gel's microsecond.
- An **out-of-range unit** yields `NULL` rather than raising a validation error.

## Not yet supported on D1 / DO

These still require the `_gel_*` custom functions (no native SQLite
equivalent / not yet lowered) and will raise `no such function` on D1/DO:

- **Datetime/duration**: `datetime_truncate`, `duration_get`, `duration_truncate`,
  `duration_to_seconds` (date-string round-trip / interval semantics).
- **`std::to_int*/to_float*/to_bigint/to_decimal`**: these are the
  format-string parsers (`to_int64(str, fmt)`); SQLite `CAST` can't replicate
  format parsing. (The `<int64>x` cast *operator* already uses native `CAST`.)
- **`decimal` / large `bigint`**: SQLite has no decimal type and uses float64,
  so precision beyond 2⁵³ cannot be preserved.
- **Regex** (`re_test`, `re_match`, `re_replace`): D1 has no `regexp`.
- **Ranges / multiranges**: the whole `range_*` / `multirange_*` family.
- **`str_repeat`, `str_reverse`, `str_split`**: no native SQLite equivalent.

## Operators already native (no difference)

The `<type>` cast operator (`<int64>x`, `<float64>x`), `abs`, `ceil`, `floor`,
`atan`, `atan2`, `pi`, and all JSON functions already lower to native SQLite and
behave identically on all targets.
