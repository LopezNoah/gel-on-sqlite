# Encapsulate the SQL lowering context; drop the module-level mutable binding

The architecture review's candidate #4 (rated speculative) flagged `gel_ir_compiler.ts`'s `_sqlLoweringContext` — a module-level `let` lazily assigned via `??=` — as a mutable-global smell.

**What it actually is.** `SqlLoweringContext` is a **stateless, frozen dispatch table** of ~23 of this module's lowering functions, passed as `deps` to the function- and group-lowering sub-modules. It exists to break an import cycle: those sub-modules can't import `gel_ir_compiler` directly, so they receive its functions through this object. It carries no per-compile state, so it is built once.

**Decision (done):** Move the memo cell from a module-level `let _sqlLoweringContext` into a closure (`const sqlLoweringContext = (() => { let cached; return () => (cached ??= …) })()`) and `Object.freeze` the table. This removes the module-global mutable binding and makes the table provably immutable, with no behaviour change. The getter's signature (`() => SqlLoweringContext`) and its 7 call sites are untouched.

**Decisions (rejected):**

- **Build the context per compile** (the review's sketched "after"). Rejected: the context is stateless, so per-compile construction would allocate a 23-property object on every compile for zero benefit. There is no per-compile state to isolate, so the "blocks isolated instantiation" concern does not actually bite.
- **Make it a top-level `const`** (no laziness). Rejected: all 23 members are `const` arrow functions declared *below* the context (e.g. `compileValueSetSQL` at line ~10966), so they are in the temporal dead zone at module load — a top-level `const` literal referencing them throws. Converting all 23 to hoisted `function` declarations would touch a 13k-line file for a cosmetic gain. The laziness is necessary; encapsulating its memo cell is the proportionate fix.

**Consequences.** No module-level mutable binding remains for the lowering context; it is a frozen, lazily-memoized, cycle-breaking dispatch table. This is a cosmetic hardening, not a depth change — recorded so a future reader understands the laziness is deliberate (TDZ), the freeze is intentional, and per-compile construction was considered and rejected.

**Why record it:** the candidate was speculative and the "obvious" fixes (per-compile build, top-level const) are both wrong for this object; this notes why, so the lazy frozen closure isn't "simplified" back into a bug.
