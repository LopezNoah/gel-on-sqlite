# Gel grammar feasibility spike

Run from `sqlite-ts`: `npx tsx scripts/grammar-spike.ts`. It requires Gel's local
`.venv/bin/python` and built `edb._edgeql_parser` extension (override the Python
executable with `GEL_PYTHON`). It does not change the production parser.

## What was tested

`scripts/grammar-spike.py` calls Gel's real `parse_block`: Rust tokenization and
grammar-table parsing (`edb/edgeql/grammar.bc`), then Python grammar reductions
that construct Gel's AST. A deliberately strict bridge converts just arithmetic
SELECT expressions and simple object shapes with a scalar field filter to
sqlite-ts's *working* AST. `scripts/grammar-spike.ts` compares this output with
`parseEdgeQLScript`, including acceptance/rejection for unmapped statements.

On the 14-case sample: 5 mapped ASTs matched sqlite-ts (including precedence,
parentheses, shapes, and a filter); 7 other syntax verdicts agreed; 2 differed:

| Input | Gel | sqlite-ts |
| --- | --- | --- |
| `CREATE TYPE Foo { BLARG; };` | Rejects `BLARG` | Accepts, with an empty `createTypeBody` |
| `DESCRIBE nonsense;` | Rejects the target | Accepts as a placeholder `describe` |

The cases also include valid statements outside the bridge (paths, Unicode
identifier, bytes literal) and malformed expression, shape, literal, and bare
statement forms. These numbers characterize only this hand-picked sample, not
overall parser parity.

## TypeScript grammar follow-on

`src/edgeql/grammar_parser.ts` is a runnable, TypeScript-only second parser,
using Chevrotain's self-validating grammar DSL over the **existing tokenizer**.
It emits the existing working `Statement` AST (the seam the compiler already
accepts), with no Python or Rust dependency at runtime. Bend-Gel's distinction
between surface parsing and core interpretation guided the placement: syntax
and AST construction live here; schema resolution and lowering stay downstream.

The supported slice is single-statement `SELECT`: literals; grouping and
precedence for arithmetic, coalescing, concat, comparisons and booleans; named
paths and function calls; simple object shapes; one-field scalar `FILTER`
predicates; and expression-valued `WITH` bindings. Unsupported tokens/grammar
forms fail explicitly; the module **does not fall back** to the handwritten
parser or affect its production routing. Call `parseEdgeQLGrammar(query)`
directly, or use the built `dist/src/edgeql/grammar_parser.js` module. The
Python script remains an *optional, offline* Gel syntax oracle.

Verification: `tests/grammar_parser.test.ts` compares 22 working ASTs with
`parseEdgeQLScript`, checks malformed and unsupported input, and compiles three
representative queries to the same SQL artifact through `CompilerService`.
`npx tsx scripts/grammar-spike.ts` additionally compared 13 of the larger
slice's accept/reject verdicts with Gel (and accepted ASTs with sqlite-ts):
13/13 matched. `npm run build` and importing the resulting ESM module work.
On a five-query, 10k-parse local microbenchmark, this implementation took
~10.8 µs/query vs ~5.6 µs/query for the existing parser. This is an initial
measurement on a narrow slice, not a full-corpus performance result.

Before making it the default, extend the *same grammar* to SELECT's richer
clauses, paths, nested shapes and expression forms; cover multi-statement
script/module semantics, DML, DDL, and SDL deliberately; compare against Gel
on the syntax corpus; and benchmark realistic queries and bundle size. Do not
route production queries to the grammar by catching its syntax errors and
retrying the old parser: that would let the old permissive parser accept the
very malformed statements the grammar is intended to reject. A production
switch needs explicit syntax coverage and AST/SQL parity first.

## Original feasibility decision

**Worth pursuing as a syntax-parity effort, but not yet as a parser rewrite.**
The existing `parseEdgeQL` interface can remain the seam: the small AST mapping
demonstrates a grammar-backed implementation can feed its callers without
changing the compiler. Gel's grammar also catches real over-acceptance in the
current DDL/admin passthrough paths.

The difficult part is not specifying productions. Gel's source grammar lives
in Python (`edb/edgeql/parser/grammar/`); `grammar.bc` is consumed by its Rust
parser, whose concrete syntax tree is reduced to the Gel AST by Python methods.
Neither the grammar table nor the Rust parser alone produces sqlite-ts's AST.
Even `SELECT User.name` is outside this tiny bridge: it needs path-to-select
normalization and default shape construction. Shaped/computed paths, bindings,
DDL, positions and error translation would each add rules. The generated
`src/edgeql/qlast.ts` mirrors Gel's AST but the compiler consumes `ast.ts`, so
using qlast directly would move the mapping task downstream. The Python process
in this spike is a development oracle, not a viable TS/browser runtime seam.

Next: use Gel's parser as an **offline differential oracle** over the existing
syntax corpus, prioritizing accepted-invalid cases that could execute
incorrectly (especially skipped DDL bodies). Before selecting a production
parser architecture, prototype one more *substantial* vertical slice with a
JS/WASM-deliverable parser and full AST mapping (paths, shapes, WITH bindings,
errors, locations); measure coverage, build size and parse time against
`scripts/bench-parser.ts`. Only replace the current parser if that mapping
stays local and brings a substantial parity gain.
