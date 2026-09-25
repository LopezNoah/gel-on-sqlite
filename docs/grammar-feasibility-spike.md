# Gel grammar feasibility spike

Run from `sqlite-ts`: `npx tsx scripts/grammar-spike.ts`. It requires Gel's local
`.venv/bin/python` and built `edb._edgeql_parser` extension (override the Python
executable with `GEL_PYTHON`). It does not change the production parser.

## What was tested

`scripts/grammar-spike.py` calls Gel's real `parse_block`: Rust tokenization and
grammar-table parsing (`edb/edgeql/grammar.bc`), then Python grammar reductions
that construct Gel's AST. A deliberately strict bridge maps a small AST subset
to sqlite-ts's working AST for arithmetic and introspection SELECTs, shapes,
function calls, and nested INSERT conflict alternatives. `scripts/grammar-spike.ts`
checks grammar-parser acceptance against Gel and compares the mapped subset
directly with Gel's AST; the handwritten parser is not the syntax or AST target.

On the 27-case sample, all Gel accept/reject verdicts agree with the grammar
parser and all 15 mapped ASTs match Gel. The remaining cases cover syntax
acceptance outside the bridge and malformed expressions, shapes, literals, and
bare statement forms. This is a hand-picked oracle sample, not full-language
coverage.

## Generated syntax recognizer and AST reduction

Gel's build already compiles its Python grammar definitions into LR
action/goto tables. `npm run codegen:edgeql-lr` exports those tables into the
checked-in `src/edgeql/generated_gel_lr_spec.ts` artifact. The TypeScript
recognizer in `src/edgeql/gel_lr_parser.ts` runs the generated tables against
the existing tokenizer, with no Python or Rust dependency at runtime. The
generated artifact is about 2.7 MB uncompressed.

The generated table is syntax recognition only: Gel's Python grammar reductions
are not in the table. `src/edgeql/grammar_parser.ts` remains a TypeScript working-
AST reducer for the syntax implemented so far. That AST is the seam consumed by
the compiler; the outstanding work is reducing the generated CST into it.

`tests/grammar_parser.test.ts` checks syntax acceptance/rejection, script
boundaries, Gel AST goldens, compiler artifacts and grammar-backed GROUP
execution. The static coverage command extracts literal expected-success queries
from conformance assertion helpers using TypeScript's parser, so string escapes
are evaluated before parsing. On 7,409 extracted queries, the manual working-AST
parser accepts **7,323 (98.8%)**; the generated Gel LR recognizer accepts
**7,389 (99.7%)**. Thirty-one interpolated templates are excluded from this
static count. The manual working-AST grammar reducer now accepts all 20 static
inputs rejected by the generated table, bringing combined static coverage to
**7,409/7,409**. Those local forms include legacy GROUP expressions, colon-
computed shape expressions, and the suite's `link *1` shape syntax. The latter is
intentionally limited to depth 1; `*5` remains rejected. The generated parser's
13-case Gel oracle probe agrees on every case, and the checked-in artifact matches
the freshly exported Gel table across the full corpus.

`SQLITE_TS_GRAMMAR_PREFLIGHT=1 npm test` runs the generated recognizer over
actual `QueryHarness.query()` and `script()` inputs, including interpolated
strings. Inputs rejected by the generated table are checked by the working-AST
grammar reducer, then by the production parser; bare SDL scripts use the schema
parser. The preflight occurs before the existing execution pipeline and does not
yet execute ASTs reduced from Gel's generated CST. The latest full preflight run
had **672 failed, 3,946 passed, and 593 skipped**; there were no failures caused
by the syntax gate. The failures are execution/compiler/expected-value issues,
not a parse-coverage metric. The generated parser is still not routed into
production.

There are no remaining syntax gaps in the 7,409-query static expected-success
corpus. The generated table still diverges from the local suite on 20 inputs;
the TypeScript working-AST grammar reducer covers those inputs. The next parser
task is expanding the new generated-CST reducer and routing execution through it.
`src/edgeql/gel_lr_ast_reducer.ts` now reduces scalar SELECTs, literals,
arithmetic, comparisons, logical operators, parentheses, simple typed-object
SELECTs, field paths, plain field shapes, and field-to-literal `FILTER` clauses
into the compiler's working AST. Tests compile and execute generated ASTs with
expected SQLite values `1`, `7`, `9`, `1`, and `0`, plus projected names `Ada`
and `[Ada, Bea]`. Unsupported result aliases, ORDER BY/pagination, nested shapes,
and multi-statement blocks are rejected explicitly. This slice is not yet used
by production query execution.

## Follow-ups

- Extend generated-CST reduction to longer paths, computed/nested shapes,
  nontrivial filters, ordering/pagination, and multi-statement blocks; the
  existing TypeScript working-AST grammar parser still handles the rest of the
  suite.
- Route query execution through the generated reducer and compare values against
  suite expectations rather than comparing ASTs.
- The full suite still reports 672 failures. Two now-visible runtime cases need
  focused follow-up: legacy SDL function calls return `null` instead of the
  selected overload result (`test_edgeql_calls_13_sdl`), and the first explicit
  nested-link query in `test_edgeql_select_recursive_01` returns the wrong root
  row. The recursive `link *1` form itself parses, but that test stops at the
  earlier assertion, so its execution result has not yet been independently
  verified.

## Initial feasibility context

Gel's source grammar lives in Python (`edb/edgeql/parser/grammar/`), while the
generated LR table is reduced to Gel's `qlast` by Python methods in
`edb/edgeql/parser/__init__.py`. The generated recognizer proves grammar
production code can remove manual syntax production maintenance. It does not
remove the need for a TypeScript reducer: Gel `qlast` is not the compiler's
working `ast.ts` representation. The active gate is test-suite syntax
acceptance—not handwritten-parser AST equality—followed by expected-value
execution using ASTs produced by the new path.
