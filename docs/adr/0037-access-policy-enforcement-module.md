# A home for access-policy enforcement (and what the 664-line write path actually is)

A round-5 architecture review proposed that "access policies have no home — read/write checks interleave with mutation across the 664-line `runWriteWithAccessPolicies`." On inspection that premise is **mostly a false positive**: the policy *decision* was already a coherent cluster of functions, and `runWriteWithAccessPolicies` only *calls* it (`enforceInsertPolicies(...)` at the insert point, the update/delete enforcers at theirs). The 664 lines are a write **executor** — its real density is INSERT default-value resolution, sequence allocation, inline-link FK resolution, SQL assembly, `UNLESS CONFLICT` validation, exclusive-constraint checks, and transaction/savepoint handling — none of which is policy logic. There was nothing to "untangle."

What was true: the cohesive policy cluster sat as ~9 bare functions scattered in the 13k-line `engine.ts`, with no module home and no test surface of its own.

**Decision (done):** add `src/runtime/access_policy.ts` and move the decision cluster verbatim into it:

- `evaluateCondition` — one policy condition vs. a row + context (`always` / `global` / `field_eq_global` / `field_eq_literal` / `and`);
- `appliesToOperation` — does a policy govern this operation (with `update` ⇒ `update_read`+`update_write`, and `all`);
- `evaluatePoliciesForOperation` — the core decision (superuser bypass, no-relevant-policy ⇒ deny, allow-any-then-deny-veto);
- `enforceInsertPolicies` / `enforceUpdateReadPolicies` / `enforceUpdateWritePolicies` / `enforceDeletePolicies` — the throw-on-deny wrappers the write path calls;
- `resolveGlobalValue` + `hasPermission` — global/permission resolution the conditions and the data-modification guard consult.

`engine.ts` imports the five it still calls (the four enforcers + `evaluatePoliciesForOperation`) plus `hasPermission`; it drops 161 lines. The module's only `engine.ts` dependency is the `SecurityContext` **type** (`import type`, erased at runtime) — so the edge is one-directional `engine → access_policy` with no runtime cycle.

**Scoped out, deliberately:** the read-time check `evaluateSelectPolicies` **stays in `engine.ts`**. It depends on the shared row helpers `rowSourceType` and `readRowById` (used across the evaluator, not policy-specific) and on the SQL read path; moving it would drag those helpers or create a cycle. It delegates its decision to `evaluatePoliciesForOperation` here, so the actual policy logic still has one home. The 664-line write executor is likewise left intact — its tangle is mutation mechanics, a separate (larger, behaviour-gated) concern.

**Verification.** Behaviour-neutral: every moved function is byte-identical; the only change at the call sites is the import. The policy-exercising slice (`insert`/`select`/`syntax`/`scope`/`triggers`/`delete`, 1656 tests) ran `250 failed / 1403 passed / 3 skipped` both before and after, with identical per-file failure counts. `tsc` clean, lint clean. New test surface: `tests/access_policy.test.ts` (16 unit tests) drives the allow/deny decision directly — superuser bypass, no-relevant-policy deny, allow-required-then-deny-veto, each condition kind, `update` applicability, global/short-name/permission resolution, and the insert enforcer's throw — none of which previously had isolated coverage.

**Consequences.** Access-policy enforcement has one module home with a small interface and a real test surface. A change to the allow/deny rule or a new condition kind happens in `access_policy.ts`, guarded by its unit tests.

**Why record it:** a future reviewer will see `runWriteWithAccessPolicies` still ~660 lines and may re-file "access policy has no home." It does — `access_policy.ts`. That function's size is mutation mechanics (defaults, sequences, conflicts, SQL assembly), not policy; do not conflate the two. And `evaluateSelectPolicies` lives in `engine.ts` on purpose: it is read-path glue over shared row helpers, delegating the decision here.
