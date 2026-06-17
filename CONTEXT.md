# sqlite-ts

The domain language of the EdgeQL→SQLite query engine. Terms here are specific to *this* rebuild's pipeline and to Gel's semantics — not general compiler vocabulary. Sharpened during the 2026-06-16 architecture review (see `docs/adr/`).

## Pipeline & IR

**Live IR**:
The IR the production pipeline actually runs on, defined in `src/ir/gel_ir.ts` and built by `src/compiler/ast_to_ir.ts`. Lowered to SQL by `src/sql/gel_ir_compiler.ts`. This is the single IR for SELECT, GROUP, and DML.
_Avoid_: gel_ir (the filename), "the new IR".

**DML IR**:
The mutation-only IR (`InsertIR` / `UpdateIR` / `DeleteIR` and their link sub-IRs) emitted by `src/compiler/dml_lowering.ts` and consumed by the engine's write path. The surviving, narrowed remainder of `src/ir/model.ts`.
_Avoid_: legacy IR (for the DML part), "the model IR".

**Legacy IR**:
The interpreter-era IR (`src/ir/model.ts` produced by `src/compiler/semantic.ts`) that the SQL pipeline replaced for routing and execution. No longer on the production path, but **retained as an inference oracle**: the 5 `edgeql_ir_*_inference` tests assert its `volatility`/`cardinality`/`multiplicity`/`scopeTree` output, which the Live IR does not yet reproduce (see `docs/adr/0001`). Not dead code.
_Avoid_: "the old IR", semantic IR.

**Inference oracle**:
`src/compiler/semantic.ts` in its retained role — the reference implementation of EdgeQL inference, kept under test until the Live IR reaches inference parity and it can be deleted.
_Avoid_: legacy compiler.

**Routing shim**:
The synthetic, kind-only `IRStatement` that `src/compiler/service.ts::traceIRFromGelIR` fabricates for non-DML statements purely so the engine's dispatch can read `ir.kind`. Slated for deletion — the engine routes on the AST's `statement.kind` instead.
_Avoid_: stub IR, fake IR.

**Compile artifact**:
The bundle `CompilerService.compile` hands the engine: the Live IR, the SQL artifact, and (for mutations) the DML IR.
_Avoid_: compile result, output.

## Inference (facts carried on the Live IR Statement)

**Cardinality**:
How many elements a set may yield: `one | many | at_most_one | at_least_one | unknown`. The Live IR has no `empty` member — an empty set is expressed via `multiplicity: "empty"`.
_Avoid_: count, arity.

**Multiplicity**:
Whether a set may contain duplicate elements: `empty | unique | duplicate | unknown`.
_Avoid_: uniqueness, distinctness.

**Volatility**:
How an expression behaves across evaluations: `immutable | stable | volatile | modifying`.
_Avoid_: purity, side-effect class.

**Scope tree**:
The path-scope structure (`ScopeTreeNode`) describing which paths are correlated vs independently iterated within a statement.
_Avoid_: scope graph, binding tree.

## Schema

**SchemaSnapshot**:
The immutable, deeply-frozen schema module (`src/schema/schema.ts`) every compile and runtime read goes through. The authoritative schema representation.
_Avoid_: schema model, schema state.

**Declarative schema**:
The parsed SDL representation (`src/schema/declarative.ts`) produced from schema source by `parseDeclarativeSchema`, converted into a `SchemaSnapshot`.
_Avoid_: schema AST, schema doc.

## Execution

**Runtime evaluator**:
The TypeScript expression interpreter (`tryRuntimeSelectExprEvaluationAst` in `src/runtime/engine.ts`) required for constructs that do not lower to SQL — free objects, FOR iteration, runtime aliases, inlined UDFs. A required component, not a fallback for the SQL path.
_Avoid_: interpreter fallback, the slow path.

## Tooling & test seams

**Compile inspection**:
`src/compiler/inspect.ts` — the seam that runs the compile pipeline (parse → Live IR → SQL artifact) **without executing against SQLite**, and projects a stable set of Compile facts plus Canonical SQL. Purely additive over `CompilerService`; reachable from the golden tests (`tests/inspect.test.ts`) and the dev CLI (`bin/inspect.ts`), which together replace the ad-hoc root runners (`qast`/`qir`/`qsql`/…). `inspect(schema, query)` returns a result that never throws on a query problem — parse/compile failures are captured as `{ ok:false, error }`. `inspectorFor(schema)` binds a schema once for terse per-query calls (no hidden global).
_Avoid_: compile probe, the inspector (for the runtime).

**Compile facts**:
The stable, artifact-derived projection that is the compiler's **test surface**: `statementKind`, `loweringMode`, `lowersToSingleSql`, `strategy` (the Execution strategy), `paramCount`, `subqueryCount`, `cteCount`, and the `irKindTree` (the Live IR node-kind skeleton, ids/names/literals stripped). Every field is true of the artifact as compiled — no heuristics that can lie.
_Avoid_: compile summary, inspection facts.

**Canonical SQL**:
The alias- and whitespace-normalized form of an artifact's SQL (`canonicalizeSql`). Generated aliases (`g0`/`p1`/`j1`/`grp_src`/`tuple_n`/`g_agg`…) are renamed to positional tokens (`a0`, `a1`, …) by first appearance, so a golden changes only when the lowering changes, not when an unrelated alias counter shifts.
_Avoid_: normalized SQL, stable SQL.

**SQL gate** (`lowersToSingleSql`):
The predicate `loweringMode === "single_statement" && sql.length > 0` — did a query compile to exactly one runnable SQL statement? Exported once from `src/sql/compiler_types.ts` and consumed by **both** the engine's dispatch and the Compile inspection seam; it was previously copy-pasted ~17× across `engine.ts` (collapsed by `docs/adr/0003`). The Compile fact `lowersToSingleSql` is exactly this gate.
_Avoid_: runs-as-sql.

**Execution strategy**:
How the engine actually runs a compiled statement: `sql` (executes off the SQL artifact), `runtime` (the Runtime evaluator / write path), or `reject` (raises `E_UNSUPPORTED`). Decided by `classifyExecutionStrategy(ast, artifact, schema)` in `src/compiler/execution_strategy.ts` — the **single source of truth** the engine dispatches on (its reject sites and its `select_expr` runtime entry, via the shared `selectExprNeedsRuntime` predicate) and the Compile inspection seam reports as its `strategy` fact, so the two cannot disagree (`docs/adr/0004`). Distinct from the SQL gate: a `select_expr` can be `lowersToSingleSql: false` yet `strategy: "sql"` (the engine runs the incomplete artifact rather than rejecting).
_Avoid_: lowering mode (that's the artifact field), the fallback path.
