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

The TypeScript grammar now parses SELECT expressions (arithmetic, booleans,
casts, sets, arrays, conditionals, nested SELECT, paths, function calls and
indexing), simple shapes and filters, ORDER BY/OFFSET/LIMIT, expression-valued
WITH bindings, basic INSERT/UPDATE/DELETE and FOR. It can also split scripts
with `parseEdgeQLGrammarScript`; module-state changes within scripts are not
supported. Unsupported forms fail explicitly: the module **does not fall
back** to the handwritten parser or affect its production routing. Call
`parseEdgeQLGrammar(query)` directly, or use the built ESM module. The Python
script remains an *optional, offline* Gel syntax oracle.

Verification: `tests/grammar_parser.test.ts` checks the working AST, invalid
input, script boundaries and SQL-artifact parity through `CompilerService`.
`npx tsx scripts/grammar-spike.ts` additionally compared 26 examples' syntax
verdicts with Gel (and accepted ASTs with sqlite-ts): 26/26 matched. `npm run
build` and importing the resulting ESM module work. A *before-expansion*
five-query microbenchmark took ~10.8 µs/query vs ~5.6 µs/query for the old
parser; remeasure on realistic queries before switching.

`npx tsx scripts/grammar-coverage.ts` extracts literal single-statement
queries from ported integration tests, ignores interpolated/multi-statement
examples, and compares ASTs against the existing parser. On this **heuristic,
duplicate-heavy sample** it found 7,294 queries the old parser accepted:
the new grammar parsed 3,326 and produced equivalent ASTs for 3,247 (~44.5%
of the sample), with **79 AST differences** to investigate. The breakdown is
2,992/5,474 SELECT, 130/1,424 WITH, 76/157 FOR, 15/22 INSERT, 1/1 DELETE,
and 0/16 GROUP AST-equal, plus 33 queries beginning with comments. UPDATE and
DDL/SDL are underrepresented by this extraction. None of these numbers proves
Gel syntax parity; the old parser can itself accept invalid syntax.

**This is not a full-language parser yet.** Next coverage clusters: type
intersections and advanced shape syntax, richer WITH and nested statements,
FOR/GROUP, DML conflict/assignment forms, session/transaction statements,
DDL bodies, SDL and script module state. Existing syntax tests alone aren't a
coverage gate: many test only rejection, and the handwritten parser's
passthroughs can accept invalid input. For a full-language replacement, measure
the accepted and rejected Gel syntax corpus, pin the AST and SQL artifacts,
resolve the 79 current AST differences, and benchmark realistic queries and
bundle size. It may be worth generating TypeScript-consumable grammar tables
from Gel's grammar *at build time*, rather than manually maintaining every
upstream production in the Chevrotain DSL; that approach still needs a
TypeScript AST reduction layer and remains unproven. Do not route production
queries to the grammar by catching its errors and retrying the old parser:
that would let the old permissive parser accept the malformed input the grammar
is meant to reject.

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
