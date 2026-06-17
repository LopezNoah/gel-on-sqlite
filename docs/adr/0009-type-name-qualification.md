# A single home for type-name qualification; one argument order

The architecture review's round-2 candidate #3 found the "qualify a bare type name into `module::name`" rule re-derived across the live pipeline under **three different argument orders**: `normalizeTypeName` was defined locally in `ir/pathid.ts` (single-arg, default module), `runtime/database.ts` (`name, moduleName`), `schema/sdl_adapter.ts` (`moduleName, name` — reversed), and `schema/migrations.ts` (`moduleName, name` — reversed); `qualifiedTypeName` was defined in `schema/schema.ts` (canonical) plus three copies (`pathid.ts`, `migrations.ts`, `uiSchema.ts`). The inconsistent signature was itself a bug magnet — a swapped `(module, name)` call silently produces a wrong qualified name.

**Decision (done):** Make `schema/schema.ts` the single home:

- `qualifiedTypeName(decl)` — widened from `(typeDef: TypeDef)` to a structural `{ module?: string; name: string }`, so `TypeDef`, `ObjectTypeDeclaration`, and the declarative type all use it. The `pathid` / `migrations` / `uiSchema` copies are deleted and import it.
- `normalizeTypeName(name, moduleName = "default")` — the bare-name qualifier, canonical argument order **`(name, moduleName)`** (the majority order). `pathid` / `database` import it directly; `sdl_adapter` (7 call sites) and `migrations` (1) had their reversed-order calls flipped to the canonical order.

The domain term is recorded in `CONTEXT.md` ("Qualified type name").

**Decision (scoped out, deliberately):** two same-named functions are **not** copies and are left in place:

- `uiSchema.ts`'s `normalizeTypeName` is **union-aware** — it splits `A | B` type strings and recurses; the base case happens to share the rule but the function is a superset, a distinct concern in the UI-schema representation.
- `client/codec.ts`'s `normalizeTypeName` is **`TypeRef`-aware** — it derives a name from a wire `TypeRef` (`id`/`nameHint`, stripping `unknown:`), not from a `(name, module)` pair.

The inference oracle (`semantic.ts`) keeps its own `normalizeTypeName` closure (it closes over `activeModule`), quarantined per `docs/adr/0001`.

**Verification.** Behaviour-neutral within the suite's order-flakiness: the schema-parsing-heavy slice (`inspect` / `inspect_corpus` / `codegen_sql` / `userddl` / `linkprops` / `linkatoms` / `select` / `insert`, 908 tests) went `203 failed / 702 passed` → `202 / 703` (one *fewer* failure, zero new). 0 type errors — the flip is type-checked, and an arg-order mistake on a `(string, string)` call would not be caught by types, so the schema-load coverage (every test loads a schema through `sdl_adapter`) is the net.

**Consequences.** The qualification rule has one home and one argument order; the reversed-order hazard is gone from the live pipeline. The union-aware and `TypeRef`-aware variants are documented as distinct, so a future reader doesn't "merge" them into the core rule.

**Why record it:** a future reader will find three same-named `normalizeTypeName` functions (core, union-aware, TypeRef-aware) and may suspect leftover duplication. Only the core qualifier was consolidated; the other two are different functions that share a name, and the oracle's copy is quarantined per ADR 0001.
