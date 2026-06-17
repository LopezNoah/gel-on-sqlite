# Route the runtime's forward link traversal through the canonical storage helpers

ADR 0010 gave the physical storage layout one home (`physical_layout.ts`: `usesLinkTable` / `resolveLinkStorageOwner`, and `linkTableName` in `codegen/sql.ts`), and ADR 0023 routed the runtime's **backlink read path** through it. A round-5 architecture review found three runtime sites the earlier rounds did not reach — they still re-spelled the junction-table formula inline and decided storage on the wrong predicate:

- `traverseLinkIds` (one link hop over an id-set, used by DML path resolution like `DELETE User.posts`), both the forward-link and computed-backlink branches: `` `${tableNameForType(typeName)}__${linkName.toLowerCase()}` `` guarded by `realLink.multi`.
- `runWriteWithAccessPolicies`' `onTargetDelete` cascade: `` `${sourceTable}__${link.name.toLowerCase()}` `` (already guarded by `usesLinkTable`, but still inline).

Two latent defects, not just duplication:

1. **`.multi` is the wrong storage predicate.** A *single* (non-`multi`) link that carries link-properties is junction-stored, so `usesLinkTable` is true but `.multi` is false. The inline `traverseLinkIds` branches would have sent such a link down the inline-`<name>_id`-column path and queried a column that does not exist. This is the same rule the SQL compiler and `resolveFieldPathValue` (the canonical runtime read at `engine.ts:1442`) already use.
2. **The inline formula skips owner resolution.** `linkTableName(qualifiedTypeName(resolveLinkStorageOwner(schema, typeDef, link)), link)` attributes an inherited link's junction table to the most-base owning type; the inline `tableNameForType(thisType)__link` names the subtype's table, which is the exact drift bug ADR 0010 closed on the compile side.

**Decision (done):** route the three sites through the canonical helpers — `usesLinkTable(link)` for the storage decision and `linkTableName(qualifiedTypeName(resolveLinkStorageOwner(schema, typeDef, link)), link)` for the junction-table name — identical to the form `resolveFieldPathValue` already uses. Six lines changed in `engine.ts`; no new module.

**Scoped out, deliberately:** the fourth `__`-suffix site the review flagged, `findExclusiveConflictId` (`engine.ts:10481`), is **not** a link table — it is a **multi-valued property** table (`multiPropertyTableName`), and it already iterates `check.tables` (the pre-resolved candidate owner tables) to handle inheritance. Its inputs are physical table names, not a `(qualifiedName, link)` pair, so `linkTableName` does not apply and `multiPropertyTableName` would need a qualified name it does not hold. Folding it in would conflate two storage rules; it stays where it is.

**Verification.** Behaviour-neutral. For a link whose storage owner is the type itself (the overwhelmingly common case), `linkTableName(qualifiedTypeName(td), link)` is byte-identical to the inline `tableNameForType(typeName)__link` because `qualifiedTypeName(td)` reproduces the already-qualified `typeName`. The affected slice (`select`/`insert`/`delete`/`for`/`linkprops`/`linkatoms`/`scope`, 1045 tests) ran `336 failed` vs the stashed baseline's `335 failed`; the single delta — `test_edgeql_insert_dependent_03` (a shape read-back that lowers via the SQL compiler, not `traverseLinkIds`) — reproduced as a pass on a second isolated run of the *unchanged* code (53→52 failures), i.e. the suite's documented order-flakiness, not a regression. `tsc` clean; the canonical helpers are already pinned by `tests/physical_layout.test.ts`, so no new unit test is added.

**Consequences.** The physical storage layout now has one home on the runtime read path *and* the forward-traversal/cascade write paths — the `.multi`-vs-`usesLinkTable` gap and the inherited-owner drift can no longer reappear in `traverseLinkIds`. Completes the ADR 0010/0023 rule for the runtime's link hops.

**Why record it:** a future reader will see one remaining inline `__` formula in `findExclusiveConflictId` and may "finish the job" by routing it through `linkTableName` too. That site is a multi-property table, not a link table; the suffix coincidence is not duplication. It is left out with reason here.
