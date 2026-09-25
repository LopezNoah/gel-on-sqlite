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
static count. A direct 13-case Gel syntax/AST probe agrees with the generated
recognizer on every case. The larger corpus has 20 unique expected-success inputs
that Gel itself rejects; those need a small suite-compatibility extension if the
goal is to parse every local test input.

`SQLITE_TS_GRAMMAR_PREFLIGHT=1 npm test` runs the generated recognizer over
actual `QueryHarness.query()` and `script()` inputs, including interpolated
strings. The preflight occurs before the existing execution pipeline; it does
not yet execute grammar-produced ASTs. Its latest full run reports 688 failed,
3,916 passed and 593 skipped. Those failures include existing
runtime/expected-value failures and the remaining local syntax mismatches, so
the count is not itself a parse-coverage metric. The generated parser is still
not routed into production.

## Initial feasibility context

Gel's source grammar lives in Python (`edb/edgeql/parser/grammar/`), while the
generated LR table is reduced to Gel's `qlast` by Python methods in
`edb/edgeql/parser/__init__.py`. The generated recognizer proves grammar
production code can remove manual syntax production maintenance. It does not
remove the need for a TypeScript reducer: Gel `qlast` is not the compiler's
working `ast.ts` representation. The active gate is test-suite syntax
acceptance—not handwritten-parser AST equality—followed by expected-value
execution using ASTs produced by the new path.
