# sqlite-ts — Architecture & Reading Guide

> **Who this is for:** you, the owner of this codebase, six months from now, with no
> AI assistant open. It answers two questions the other docs don't:
> **(1) how does a query actually flow through my code, end to end?** and
> **(2) where do I start reading each part?**
>
> **How this fits with the other docs:**
> - `CONTEXT.md` is the **glossary** — it defines the vocabulary (Live IR, scope tree,
>   polymorphic source…) and assumes you already know the shape of the system. Reference, not a tour.
> - `docs/adr/*` are **decision records** — they explain *why* a given module is shaped the
>   way it is. Great when you ask "why is this split out?", not for "what runs when?".
> - **This file** is the **map and the tour.** Read it first, then dip into the glossary
>   and ADRs for depth.
>
> **About the line numbers below:** they are anchors as of 2026-06-26 and *will drift* as you
> edit. The **function names are the durable reference** — if a line number is stale,
> `grep -n "functionName" path/to/file.ts` will find it again. Every name in this doc is a
> real top-level `export const` / `export function` you can jump to.

---

## 1. The 30-second mental model

This is a from-scratch TypeScript reimplementation of Gel/EdgeDB's EdgeQL query engine,
targeting **SQLite** instead of Postgres. Because SQLite is embedded, there's no
client/server split — the whole thing runs in one process: you hand it EdgeQL text, it hands
you back rows.

A query goes through six stages:

```
  EdgeQL text
      │  ① tokenize            src/edgeql/tokenizer.ts
      ▼
  Token[]
      │  ② parse               src/edgeql/parser.ts
      ▼
  AST (Statement)             src/edgeql/ast.ts
      │  ③ compile to Live IR  src/compiler/ast_to_ir.ts   (+ inference, scope tree)
      ▼
  Live IR (Set graph)         src/ir/gel_ir.ts
      │  ④ lower to SQL        src/sql/gel_ir_compiler.ts
      ▼
  { sql, params }             (a GelIRSQLArtifact)
      │  ⑤ route               src/compiler/execution_strategy.ts
      ▼
  ⑥ execute                   src/runtime/engine.ts
      ├─ SQL path:     run the SQL on SQLite, decode rows   (row_codec.ts)
      └─ runtime path: interpret in TypeScript              (evaluator.ts)
  rows
```

Stages ③ and ④ are wrapped together by **`CompilerService.compile`**
(`src/compiler/service.ts:61`) and the whole thing is driven by **`executeQuery`**
(`src/runtime/engine.ts:1578`). If you only remember two function names, remember those two.

The single most important design decision: **EdgeQL lowers to one SQLite SQL statement
whenever possible** (the fast, correct path). Constructs that *can't* be expressed as SQL —
free objects, `FOR` loops, inlined user functions — fall back to a **TypeScript interpreter**
(`src/runtime/evaluator.ts`). This is not a slow-path fallback for failures; it's a required
second execution mode. See §6.

---

## 2. The pipeline, stage by stage

Each stage below lists: what it does, the **entry function** to start reading at, what it
consumes and produces, and the honest hard parts.

### ① Tokenize — text → `Token[]`

- **Entry:** `tokenize(input)` / `tokenizeWithStarts(input)` — `src/edgeql/tokenizer.ts:1253`
- **Produces:** a flat `Token[]` (keywords, identifiers, literals, punctuation) plus line-start
  offsets for error locations (`offsetToLineCol`, line 259).
- **Readability:** good. It's a hand-written character-code scanner (`CC_*` constants,
  `charCodeAt`) optimized for speed, but the keyword tables at the top
  (`UNRESERVED_KEYWORDS`, `CURRENT_RESERVED_KEYWORDS`, …) read like configuration and the
  scan loop is conventional. Start at the keyword tables, then read the main loop.
- **Note:** the *schema* language (SDL) has its own separate tokenizer
  (`src/schema/schema_tokenizer.ts`) — see §5. They deliberately don't share code (ADR 0025).

### ② Parse — `Token[]` → AST

- **Entry:** `parseEdgeQL(input, options)` — `src/edgeql/parser.ts:9118` (one statement);
  `parseEdgeQLScript` (`:9142`) for multi-statement scripts.
- **Core:** a recursive-descent parser. The driver is the `parseStatement()` method
  (`:945`); from there it's one method per grammar production (`parseSelect`, `parseInsert`,
  `parseShape`, `parseExpr`, …). Recursive descent mirrors the grammar, so once you find the
  method for a construct, it reads top-to-bottom.
- **Produces:** an AST `Statement` (the working AST types are in `src/edgeql/ast.ts`; the
  fuller grammar-faithful type catalogue is `src/edgeql/qlast.ts`).
- **Readability:** **B.** This is a 9,200-line file, which is a lot — but recursive descent is
  the most navigable of the four giant files because each method maps to a grammar rule. To
  find how `GROUP ... BY` parses, grep for `parseGroup`. The size is the cost; the structure
  is sound.

### ③ Compile AST → Live IR

- **Entry:** `compileASTToGelIR(statement, options)` — `src/compiler/ast_to_ir.ts:10703`
- This is where EdgeQL *semantics* get resolved: paths are bound to schema pointers, types are
  inferred, shapes are expanded, `WITH` bindings inlined. The output is the **Live IR** — a
  recursive graph of `Set` nodes (`src/ir/gel_ir.ts`), each wrapping an `Expr` tagged by
  `.expr.kind` (`pointer`, `operator_call`, `function_call`, `select_expr`, `type_root`, …).
- Alongside building the IR, `compileASTToGelIR` runs **inference**
  (`src/compiler/inference.ts` — cardinality, multiplicity, volatility, type) and populates the
  **scope tree** (`src/ir/scope_builder.ts` — which paths correlate vs. iterate independently).
  These facts ride along on the IR.
- **Useful sub-entry points:** `resolvePointerRef` (`:1088`, bind a `.field` to a schema
  pointer), `extendPathSetDirectional` (`:935`, extend a path chain), `resolveBinding`
  (`:1937`, look up a `WITH` name), `compileFreeObjectExpr` (`:3587`).
- **Readability:** **C** — and arguably the single hardest file to *learn*. It's one large
  **mutually-recursive builder**: most functions call most other functions, so there's no clean
  layering to follow (ADRs 0040/0041 record why the expr/shape "seams" people expect don't
  actually exist here). The entry point is near the *bottom* (`:10703`); the building blocks are
  above it. Read `compileASTToGelIR` first to see the top-level shape, then follow it down into
  the helpers it calls.

### ④ Lower Live IR → SQL

- **Entry:** `compileGelIRToSQL(gelIr, options)` — `src/sql/gel_ir_compiler.ts:129`
- Turns the IR `Set` graph into **one SQLite SQL string + a `params` array**, returned as a
  `GelIRSQLArtifact = { sql, params, loweringMode }` (type in `src/sql/compiler_types.ts`). If a
  construct can't be lowered, the relevant function returns `null` and `loweringMode` becomes
  `"fallback_multi_query"` — the signal to the engine to interpret it instead.
- **The four engines you'll keep returning to** (they call each other constantly):
  - `compileScalarSelectSQLInner` (`:2516`) — *Set → rows* (one row per element of a set)
  - `compileValueSetSQL` (`:10582`) — *Set → a single scalar value* (a column / operand)
  - `compilePredicateSetSQL` (`:9904`) — *Set → a `WHERE` boolean* (FILTER clauses)
  - `compileShapeProjection` (`:8947`) — *one shape element → a JSON projection* (`Foo { bar }`)
- **Read `sqlLoweringContext` (`:83`) early.** It's a frozen bundle of ~40 of this file's
  functions, handed to the extracted sibling modules (`group_lowering.ts`, `existence_proof.ts`,
  `optional_comparison.ts`) so they can call back in without a circular import. It's the map of
  how this file connects to its neighbours.
- **Readability:** **C.** Detailed assessment in §4 — this is the biggest file (13,004 lines)
  and the navigation is grep-driven. The saving grace: ~20% of lines are *why*-comments, almost
  every one anchored to a concrete EdgeQL example.
- DML (`insert`/`update`/`delete`) has a parallel lowering: `compileDmlToIR`
  (`src/compiler/dml_lowering.ts`) produces a mutation plan (the "DML IR") that the engine's
  write path consumes.

### ⑤ Route — decide how to run it

- **Entry:** `classifyExecutionStrategy(ast, artifact, schema)` — `src/compiler/execution_strategy.ts:205`
- Returns one of three strategies: **`sql`** (run the SQL artifact), **`runtime`** (interpret in
  TS), or **`reject`** (raise `E_UNSUPPORTED`). This is the *single source of truth* the engine
  dispatches on — so the engine and the inspection tool can never disagree (ADR 0004).
- The related predicate `lowersToSingleSql` (the "SQL gate", in `compiler_types.ts`) answers the
  narrower "did this compile to exactly one runnable SQL statement?".

### ⑥ Execute — produce rows

- **Entry:** `executeQuery(db, schema, query)` — `src/runtime/engine.ts:1578`
  (and `executeQueryWithTrace`, `:3906`, which also returns the AST/IR/SQL it went through —
  great for debugging; `executeScript`, `:1627`, for multi-statement input).
- **SQL path:** run `artifact.sql` against SQLite, then decode each row back into an EdgeQL
  value with `materializeGelSQLRows` / `normalizeGelSQLValue` (`src/runtime/row_codec.ts:46/21`).
- **Runtime (interpreter) path:** `runSelectExprEvaluation(...)` (`src/runtime/evaluator.ts`)
  for free objects, `FOR`, runtime aliases, inlined UDFs.
- **Write path:** the write executor `runWriteWithAccessPolicies` (in `engine.ts`) orchestrates
  INSERT/UPDATE/DELETE — calling out to `access_policy.ts`, `default_resolution.ts`,
  `conflict_detection.ts` (`UNLESS CONFLICT`), and `dml_sql.ts` (emit the final INSERT SQL).

---

## 3. Trace a query yourself (no AI required)

This is the most important section for your stated goal. There is a **built-in tool that dumps
every stage of the pipeline** for any query — `bin/inspect.ts`:

```bash
cd sqlite-ts

npx tsx bin/inspect.ts ast   "SELECT Issue { name }" --schema issues   # the parsed AST  (stage ②)
npx tsx bin/inspect.ts raw   "SELECT Issue { name }" --schema issues   # the full Live IR (stage ③)
npx tsx bin/inspect.ts ir    "SELECT Issue { name }" --schema issues   # the IR node-kind skeleton
npx tsx bin/inspect.ts sql   "SELECT Issue { name }" --schema issues   # the emitted SQLite SQL (stage ④)
npx tsx bin/inspect.ts facts "SELECT Issue { name }" --schema issues   # strategy, param/CTE counts, etc.
```

`--schema NAME` loads `tests/schemas/NAME.esdl` (e.g. `issues`, `cards`, `advtypes`). This
crosses the same seam (`src/compiler/inspect.ts`) the golden tests use, so what you see is
exactly what the engine compiles.

**A worked example.** Run `npx tsx bin/inspect.ts sql "SELECT Issue { name }" --schema issues`.
You'll get the SQL. Now you can:
1. See it's a `json_object(...)` projection over a `SELECT ... FROM "Issue"` — that's
   `compileShapeProjection` (stage ④) at work.
2. Want to know *why* it shaped that way? Grep `gel_ir_compiler.ts` for `compileShapeProjection`
   and read the guard your query hit (each has a why-comment).
3. Want the IR it came from? Re-run with `raw` and you'll see the `Set` graph that stage ③ built.

To run the query for real and see results, use `executeQueryWithTrace` (it returns the
intermediate steps too). The repo also has small one-off debug scripts at the root
(`qsql.ts`, `csql.ts`, `sdbg.ts`, …) that load a fixture schema and run a query — handy
scratchpads, but `bin/inspect.ts` is the maintained one.

**This tool is your replacement for asking an AI "what does this query compile to?"** — it
answers definitively, every time.

---

## 4. The four big files (the readability hazard)

~43,000 of the ~90,000 lines of `src/` live in **four files**. This is the honest weak point of
the codebase, so it gets its own section.

| File | Lines | Role | Grade |
|------|------:|------|:-----:|
| `src/sql/gel_ir_compiler.ts` | 13,004 | Live IR → SQL | C |
| `src/compiler/ast_to_ir.ts` | 10,911 | AST → Live IR | C |
| `src/runtime/engine.ts` | 10,777 | execute / route / write | C |
| `src/edgeql/parser.ts` | 9,200 | tokens → AST | B |

**What's *good* about them** (this is real, not consolation):
- **Naming is excellent and grep-able.** A consistent vocabulary: `compile*` emits SQL,
  `tryCompile*` attempts one narrow case and returns `null` to bail, `collect*` walks the tree,
  `is*/has*/reaches*` are predicates. You can find the handler for almost anything by guessing
  its name and grepping.
- **Comment density is high where it matters** — `gel_ir_compiler.ts` is ~20% comments, and
  almost every tricky branch opens with a concrete EdgeQL example and the SQLite-semantics gap it
  works around. These comments are the most trustworthy thing in the files.

**What's *hard* about them** (be honest with yourself here):
- **They're too big to read top-to-bottom, and have no section banners.** You navigate by
  symbol search, not by reading. There is no map inside the file telling you where things are.
- **The core functions are guard cascades, not dispatch tables.** `compileScalarSelectSQLInner`
  (~1,966 lines) is ~100 sequential `if (very-specific-IR-pattern) { return hand-built SQL }`
  blocks. Two guards can both plausibly match a query; *which one wins depends on source order*,
  and nothing makes that explicit. To know what a query compiles to, you mentally execute the
  guards in order.
- **The IR is matched by string then hand-cast.** `set.expr.kind === "operator_call"` followed
  by `set.expr as OperatorCall` — 400+ unchecked casts. TypeScript is *not* verifying these for
  you, and some structural casts (`set as { dynamicTypeName?: boolean }`) read fields the
  declared IR type doesn't even expose. Part of the true IR shape lives only in these scattered
  casts. (This is the highest-value thing you could harden later — see §8.)
- **`params` mutates by side effect.** SQL bind values accumulate into a shared `params` array,
  with a `const cp = params.length; ... params.length = cp` checkpoint/rollback idiom (~105
  sites) to undo a partial attempt before bailing. Watch for it before assuming a `return null`
  is clean.
- **Correlation vs. factoring is implicit.** Whether `count(Card.name)` correlates per-row or
  scans the whole set hinges on marker flags threaded through the options bag
  (`multiScalarBindings`, `groupRowProjection`, `isWithBinding`) that you won't know to look for.
  This cluster has historically been the most bug-prone.

**A representative slice** (from `gel_ir_compiler.ts`, the archetypal guard — multiply by ~100):

```ts
// EdgeQL `A EXCEPT B` / `A INTERSECT B` are MULTISET operators — they keep
// per-element multiplicity, unlike SQLite's set-deduping EXCEPT/INTERSECT.
// ... `{1,1,1,2,2,3} except {1,3,3,2}` → `{1,1,2}` ...
if (sourceSet.expr.kind === "operator_call"
  && ((sourceSet.expr as OperatorCall).operator === "except"
    || (sourceSet.expr as OperatorCall).operator === "intersect")) {
  const setOp = sourceSet.expr as OperatorCall;
  const opArgs = orderedCallArgs(setOp.args);
  if (opArgs.length === 2) {
    const cp = params.length;                                   // checkpoint
    const leftRows = compileScalarSelectSQL(opArgs[0].expr, params, target, options);
    const rightRows = leftRows ? compileScalarSelectSQL(opArgs[1].expr, params, target, options) : null;
    if (leftRows && rightRows) {
      const cmp = setOp.operator === "except" ? ">" : "<=";
      const v = quoteIdent("value");
      return `SELECT ${v} FROM (SELECT ${v}, ROW_NUMBER() OVER (PARTITION BY ${v}) AS __rn FROM (${leftRows})) lx WHERE lx.__rn ${cmp} (SELECT COUNT(*) FROM (${rightRows}) rx WHERE rx.${v} IS lx.${v})`;
    }
    params.length = cp;                                         // rollback on bail
  }
}
```

**How to survive these files:** don't read them; *query* them. Use `bin/inspect.ts` to see what
a query produces, grep for the function name in the output, read that one function and its
comment. The files reward targeted lookups, not linear reading.

**Why aren't they split up?** They've been worked on (see the ADRs — dozens of focused modules
*have* been carved out of them). The remaining cores resist splitting because they're
genuinely, irreducibly mutually-recursive: `ast_to_ir`'s builder and `gel_ir_compiler`'s engines
each form one tangled call graph. ADRs 0040/0041 document specific cases where a split was
attempted and rejected as a false seam. The pragmatic fix is navigation aids (this doc, the
inspect tool, the naming convention), not forcing a split.

---

## 5. The schema subsystem (a parallel front end)

Schema definition (SDL) is parsed by a *completely separate* front end from EdgeQL queries —
don't confuse the two. The conversion chain:

```
SDL text (.esdl / module { ... })
   │  parseDeclarativeSchema      src/schema/sdl_adapter.ts  (tokenized by schema_tokenizer.ts)
   ▼
DeclarativeSchema                 src/schema/declarative.ts
   │  schemaSnapshotFromDeclarative   src/schema/uiSchema.ts
   ▼
SchemaSnapshot                    src/schema/schema.ts   ← the authoritative, immutable schema
```

- **`loadSchema(source)`** (`src/schema/load.ts`) is the one-step facade for the whole chain —
  use it rather than wiring the two steps by hand (ADR 0005).
- **`SchemaSnapshot`** (`schema.ts`) is the frozen object *every* compile and runtime read goes
  through. Key methods: `getType`, `listTypes`, `concreteTypeNamesUnder` (subtype closure),
  `qualifiedTypeName`.
- **Physical layout** (`src/schema/physical_layout.ts`) answers "given the logical schema, what
  does the SQLite layout look like?" — which links get a junction table vs. an inline `_id`
  column, which type owns an inherited link. Both the SQL compiler and the runtime read this one
  module so they can't drift.
- **Persistence** (`src/schema/gel_persistence.ts`, `gel_table_decoder.ts`) serializes a schema
  into `gel_*` metadata tables and reads it back, so `schema::*` introspection queries work.
- **Migrations** (`src/schema/migrations.ts`, `migration_session.ts`) diff two schemas and emit
  the SQL DDL to get from one to the other.

Readability here is **B** overall: `schema.ts`, `physical_layout.ts`, `type_member_resolver.ts`,
`load.ts` are small and clean; `sdl_adapter.ts` (2,548) and `schema_tokenizer.ts` (2,404) are
large but, like the query parser, are conventional parsers you navigate by production name.

---

## 6. The SQL ↔ interpreter split

This is the architectural decision that shapes the whole runtime, so it's worth understanding
directly.

- **Preferred path: lower everything to one SQLite statement.** Fast, and it pushes correctness
  down to SQLite's own query engine. `classifyExecutionStrategy` returns `sql`.
- **Required fallback: the TypeScript interpreter** (`src/runtime/evaluator.ts`,
  `runSelectExprEvaluation`). Some EdgeQL has no single-SQL expression — free objects
  (`SELECT { a := 1, b := 2 }`), `FOR x IN ... UNION ...`, runtime aliases, inlined user-defined
  functions. These are interpreted in TS over rows fetched from SQLite.

The interpreter is **not** a slow-path for handling failures — it's a legitimate second
execution mode. The way to tell them apart in the code: the engine asks
`classifyExecutionStrategy`; if a `select_expr` `lowersToSingleSql: false`, it routes to the
evaluator. The evaluator reaches back into the engine through an **explicit injected `deps`
object** (`SelectExprEvaluatorDeps`) — so the coupling between interpreter and engine is visible
and listed, not hidden (ADR 0044). If that dependency set ever grows, that's the signal a
construct should probably lower to SQL instead.

Many small, focused, *individually readable* modules support the runtime — these are the model of
what "good" looks like in this codebase, mostly carved out behind documented seams and pinned by
unit tests: `row_codec.ts`, `co_iteration.ts`, `type_narrowing.ts`, `access_policy.ts`,
`default_resolution.ts`, `conflict_detection.ts`, `dml_sql.ts`. Backends are adapter modules:
`database.ts` (SQLite), `d1_adapter.ts` (Cloudflare D1), `do_adapter.ts` (Durable Objects),
`wasm_adapter.ts`.

---

## 7. Module map & readability grades

Grade scale: **A** = read top-to-bottom and follow it · **B** = readable with modest effort ·
**C** = readable in pieces, needs grep + context · **D/F** = needs the author.

| Area | Key files | Lines | Grade | Where to start |
|------|-----------|------:|:-----:|----------------|
| **edgeql** (lex/parse/AST) | `tokenizer.ts`, `parser.ts`, `ast.ts`, `qlast.ts` | 13,560 | B | `parseEdgeQL` → `parseStatement()` |
| **ir** (the data model) | `gel_ir.ts`, `pathid.ts`, `scope_builder.ts`, `model.ts` | 2,482 | B+ | `gel_ir.ts` (the `Set`/`Expr` types) |
| **compiler/ast_to_ir** | `ast_to_ir.ts` | 10,911 | C | `compileASTToGelIR` (:10703) |
| **compiler** (rest) | `inference.ts`, `dml_lowering.ts`, `service.ts`, `execution_strategy.ts`, `inspect.ts` | 5,345 | B (service/inspect/strategy: A) | `service.ts` then `execution_strategy.ts` |
| **sql/gel_ir_compiler** | `gel_ir_compiler.ts` | 13,004 | C | `compileGelIRToSQL` (:129) + `sqlLoweringContext` (:83) |
| **sql** (helpers) | `function_lowering.ts`, `optional_comparison.ts`, `existence_proof.ts`, `group_lowering.ts`, `pointer_join.ts` | 3,562 | B+ | `pointer_join.ts` (small, self-contained) |
| **runtime/engine** | `engine.ts` | 10,777 | C | `executeQuery` (:1578) |
| **runtime** (rest) | `evaluator.ts`, `row_codec.ts`, `access_policy.ts`, `conflict_detection.ts`, adapters | 7,588 | A–/B+ | `row_codec.ts`, `co_iteration.ts` (tiny, model code) |
| **schema** (front end) | `sdl_adapter.ts`, `schema_tokenizer.ts`, `declarative.ts` | ~6,000 | B | `loadSchema` (`load.ts`) |
| **schema** (model/migrate) | `schema.ts`, `physical_layout.ts`, `type_member_resolver.ts`, `migrations.ts` | ~4,000 | B (small ones: A) | `schema.ts` |
| **schema** (persistence) | `gel_persistence.ts`, `gel_table_decoder.ts`, `schema_introspection.ts` | ~3,400 | B | `gel_table_decoder.ts` |
| **stdlib** | `registry.ts`, `functions.ts` | 1,518 | A | `registry.ts` (reads like a config table) |
| **client / codegen / migrate / http** | `client/index.ts`, `codegen/sql.ts`, `migrate/migrator.ts`, `http/server.ts` | ~2,800 | A/B | `client/index.ts` |

> `src/codegen/generated/schema_model.ts` (3,535 lines) is **generated output**, not
> hand-written — don't read it; regenerate it with `npm run codegen:schema-model`.

---

## 8. The honest verdict — is this code human-readable?

**Mostly yes, with four real hazards. Overall grade: B.**

You *can* understand this codebase without an AI assistant — but how hard it is depends entirely
on which part you're in:

- **The small modules (≈85% of the files, ≈55% of the lines) are genuinely good.** Focused,
  well-named, well-commented, many deliberately carved out behind documented seams and pinned by
  tests. `service.ts` is a model: every non-obvious line has a *why*-comment. The existence of
  **63 ADRs** and a maintained `CONTEXT.md` is strong evidence of sustained design discipline —
  better documentation than most professional codebases have.
- **The four giant files (≈45% of the lines) are the problem.** They're *micro*-readable (good
  names, dense comments) but *macro*-hard: you navigate them by grep, not by reading, because
  they're long guard-cascades and mutually-recursive builders with no internal map. You will
  always spend real effort in `ast_to_ir.ts` and `gel_ir_compiler.ts`.

**What makes it survivable without an AI:**
1. **`bin/inspect.ts`** — dumps AST/IR/SQL/facts for any query. Your definitive
   "what does this do?" tool (§3).
2. **The naming convention** — `compile*` / `tryCompile*` / `collect*` / `is*` lets you find
   things by grep.
3. **The why-comments** — anchored to concrete EdgeQL examples, right at the hard branches.
4. **`CONTEXT.md`** (vocabulary) + **`docs/adr/`** (rationale) + **this file** (the map).

**If you want to make it *more* readable later** (highest value first):
1. **Turn the IR into a real discriminated union** so `set.expr.kind === "..."` narrows the type
   automatically and the 400+ hand-casts in `gel_ir_compiler.ts` disappear. This is the single
   biggest correctness-and-readability win, and it's the kind of large mechanical change that's
   well-suited to either a careful manual pass or an AI session while you still have one.
2. **Add section-banner comments** inside the four big files (the file-region maps already exist
   in your head and in this doc's §4 — write them into the files as `// ===== SHAPE PROJECTION
   =====` dividers).
3. **Document the option-bag flags** (`multiScalarBindings`, `isWithBinding`,
   `groupRowProjection`) where the options type is defined — they carry semantics that are
   currently tribal knowledge.

None of these are urgent. The code works (the test suite is the proof), it's documented, and it's
navigable with the tools above. The four big files are a known, bounded cost — not a sign the
codebase is out of control.

---

## 9. Where to go next

- **"What does term X mean?"** → `CONTEXT.md`
- **"Why is module Y shaped this way?"** → `docs/adr/` (the index is the filenames; they're numbered in order of decision)
- **"What does query Z compile to?"** → `npx tsx bin/inspect.ts sql "Z" --schema <name>`
- **"How do I run / build / test this?"** → `README.md`
</content>
</invoke>
