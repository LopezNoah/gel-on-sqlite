# Known-blocked conformance tests

Policy for tests ported from the upstream EdgeDB Python suite that cannot
pass (or cannot be meaningfully asserted) without harness/protocol features
the port doesn't model. These are distinct from ordinary failures, which
indicate compiler/engine gaps and stay in the failing set on purpose.

Marking rules:

- Use `it.skip(...)` with an `XBLOCKED[<category>]` comment directly above
  the first skipped test of a group, naming the blocking feature and (when
  applicable) the contradiction. Never delete the test or change its
  expectations.
- A test is only eligible when its *sole* blocker is harness/protocol-level.
  If the query itself fails to compile or returns wrong rows, it is NOT
  eligible — that's an engine bug and must stay failing (e.g.
  `tid_position_04/05` fail in the query layer and remain unskipped).
- When the blocking feature lands, remove the skip in the same change.

## Current entries

| Tests | Category | Blocker |
| --- | --- | --- |
| `test_edgeql_select_tid_position_01..03` (edgeql_select.test.ts) | protocol | Assert `__dataclass_fields__` pointer ordering — Python-driver result-object metadata. 02 vs 03 run the identical query but assert different orderings (upstream runs them under different protocol flags). Needs typed result descriptors from the Client codec. |

## Not skipped (fixture bugs, fixed instead)

`test_edgeql_select_match_07/08`-style failures caused by the Python→TS
conversion mangling backslashes inside template literals are *fixture bugs*:
the fix is restoring the runtime string to the upstream original (backslashes
doubled), never skipping.
