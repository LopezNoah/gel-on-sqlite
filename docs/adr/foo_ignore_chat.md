Repository-state caveat
- ADRs 0061–0064 are marked implemented.
- ADR 0065 is committed as “Accepted,” but the working tree appends THIS IS NOT YET FINISHED (pretty sure) at line 25.
- ADR 0066 is currently an untracked working-tree document, despite saying “Accepted.” Treat it as an accepted design/draft, not proven-complete implementation.
- ADR 0061 contains stale historical text at lines 167–173 saying the 9 behavior is deferred; its status, implementation section, and tests show that behavior is now implemented.
1. Exact deferred requirements
A. Factoring and scope-tree convergence
A1. Dedup-aware collapse for pointer prefixes
Exact requirement:
“A dedup-aware collapse for pointer prefixes is future work.”
Reference:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0061-shared-prefix-count-factoring.md:133-143
The current gate explicitly rejects non-type-root shared prefixes because raw pointer joins can contain multiple edges for one target identity:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/src/sql/function_lowering.ts:295-305
This is the direct predecessor of ADR 0066.
A2. Fix pointer scalar projection by owning-object identity
Exact diagnosis/requirement:
“SELECT DISTINCT <leaf> — dedups by scalar VALUE (cost→5) instead of by the leaf's OWNING OBJECT (card→9).”
and:
“the fix (dedup by owning object) touches all of them and needs full-suite validation.”
Reference:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0061-shared-prefix-count-factoring.md:153-158
There is now a binding-specific workaround that projects (target id, scalar value) before dropping the id, but the generic path still performs SELECT DISTINCT over the scalar:
- Binding-specific identity handling: /Users/noahlopez/Development/Github/gel/sqlite-ts/src/sql/gel_ir_compiler.ts:4854-4860
- Remaining scalar-value dedup: /Users/noahlopez/Development/Github/gel/sqlite-ts/src/sql/gel_ir_compiler.ts:4862
Thus the generic requirement remains exactly what ADR 0066 formalizes.
A3. Preserve filtered binding correlation
Exact diagnosis:
“the binding's filter/correlation is erased; the computable cards := Card is evaluated globally. A binding-correlation rework.”
Reference:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0061-shared-prefix-count-factoring.md:159-163
ADR 0065 and the current ObjectSelectBinding implementation appear to be the intended rework. In particular, the compiler now retains complete SELECT sources, including clauses:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/src/compiler/ast_to_ir.ts:2248-2256
This requirement may now be partially or fully implemented, but the ADR status and tests have not been reconciled conclusively.
A4. Backlink path deduplication and computed aggregate leaves
Exact deferred diagnosis:
“Blocked on backlink path-dedup semantics, not the gate.”
The affected query is:
SELECT count((Card.owners.name, Card.owners.deck_cost));
Expected result: 16.
References:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0061-shared-prefix-count-factoring.md:145-152
- /Users/noahlopez/Development/Github/gel/sqlite-ts/tests/edgeql_scope.test.ts:3158-3165
- /Users/noahlopez/Development/Github/gel/sqlite-ts/failing-query-groups.md:1907-1947
Two distinct requirements are implied:
1. Deduplicate Card.owners by owner identity before counting.
2. Permit a shared-prefix tuple member such as computed deck_cost := sum(...), rather than requiring every leaf to be a direct scalar pointer.
A5. Replace direct factoring signals with one scope-tree mechanism
Exact convergence target:
“analyzeTreeFactoring … is the convergence target: ADR 0061 layer 3 would route the two direct signals above through it, leaving one mechanism.”
The two direct signals are:
- tupleSharedPrefixCorrelated
- countArgIsFactored
References:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/src/ir/scope_tree.ts:7-16
- /Users/noahlopez/Development/Github/gel/sqlite-ts/CONTEXT.md:61-63
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0062-scope-tree-pformat-and-prune-ir-analysis.md:60-67
The current architecture still has one conceptual authority but multiple live transport mechanisms.
A6. Real PathIds and 1:1 Gel scope-tree goldens
Exact gap:
“The FENCE/BRANCH shape matches Gel; the derived names do not yet.”
and:
“The golden test pins sqlite-ts's own output, not a 1:1 match against Gel's scopetree.py goldens; the latter is the layer-3 milestone.”
References:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0062-scope-tree-pformat-and-prune-ir-analysis.md:69-78
- /Users/noahlopez/Development/Github/gel/sqlite-ts/CONTEXT.md:57-62
- /Users/noahlopez/Development/Github/gel/sqlite-ts/tests/scope_tree_format.test.ts:14-19
Current scope-tree paths are structural sig: segment chains rather than real typed PathIds.
A7. Generalize count correlation beyond the narrow ADR-0059 case
Exact scoped-out work:
“Multi-valued links (count(Card.owners)), chained scalar paths, and other set-aggregates (sum/array_agg/…) keep their current lowering…”
and:
“Generalizing the correlation (and promoting the mark toward the full with:-namespace scope model) is the larger continuation.”
Reference:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0059-binding-scope-count-correlation.md:54-59
This is adjacent to, but broader than, ADR 0061’s tuple-count fix.
B. First-class object-binding identity
B1. Preserve object WITH binding meaning in Live IR
Exact decision:
“Object-valued WITH bindings will retain first-class semantic identity in the Live IR instead of collapsing to a type root and asking SQL lowering to reconstruct their source iteration.”
The first increment must include:
“object SELECT bindings, including carried shapes and FILTER/ORDER BY/LIMIT/OFFSET”
and references must use:
“an opaque compile-local binding identity”
Reference:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0065-first-class-object-binding-identity.md:7
Current implementation evidence:
- BindingId and ObjectSelectBinding: /Users/noahlopez/Development/Github/gel/sqlite-ts/src/ir/gel_ir.ts:179-186
- Statement-owned binding definitions: /Users/noahlopez/Development/Github/gel/sqlite-ts/src/ir/gel_ir.ts:205-230
- visible_binding_expr: /Users/noahlopez/Development/Github/gel/sqlite-ts/src/ir/gel_ir.ts:380-384
- Identity allocation and source retention: /Users/noahlopez/Development/Github/gel/sqlite-ts/src/compiler/ast_to_ir.ts:2248-2256, 2310-2323
- SQL-seam resolution: /Users/noahlopez/Development/Github/gel/sqlite-ts/src/sql/gel_ir_compiler.ts:6184-6203
B2. No lossy type-root fallback
Exact requirement:
“A recognized object WITH binding must not fall back to lossy type-root inlining when its source clauses or carried members cannot be represented.”
Reference:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0065-first-class-object-binding-identity.md:11-12
Failure must be explicit rather than silently replacing the binding with the full type extent.
B3. Lexical names are not identity
Exact requirement:
“Nested bindings and shadowing receive distinct identities; names are lexical lookup keys only.”
Reference:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0065-first-class-object-binding-identity.md:13
This means repeated references to one binding share semantic origin, while a shadowing binding with the same spelling receives another BindingId.
B4. Runtime captures must have the same meaning
Exact requirement:
“Runtime-generated object captures use the same Live IR meaning as ordinary object WITH bindings.”
Reference:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0065-first-class-object-binding-identity.md:14
No separate runtime-only identity model should be introduced.
B5. Preserve existing factoring semantics
Exact requirement:
“The first implementation preserves the existing correlated 9 versus factored 81 behavior and adds behavioral coverage for filtered bindings.”
Reference:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0065-first-class-object-binding-identity.md:15
Existing behavioral anchors:
- Correlated 9: /Users/noahlopez/Development/Github/gel/sqlite-ts/tests/scope_factoring_gate.test.ts:15-19
- Factored 81: /Users/noahlopez/Development/Github/gel/sqlite-ts/tests/scope_factoring_gate.test.ts:21-28
- Filtered binding expected 0: /Users/noahlopez/Development/Github/gel/sqlite-ts/tests/edgeql_scope.test.ts:3146-3155
B6. Remove temporary binding transport/reconstruction
Exact deferred statement:
“bindingAst and object-binding shape reconstruction are temporary transport mechanisms, not part of the destination.”
Reference:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0065-first-class-object-binding-identity.md:11
bindingAst is still live:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/src/compiler/ast_to_ir.ts:2193-2197
- /Users/noahlopez/Development/Github/gel/sqlite-ts/src/compiler/ast_to_ir.ts:5351
B7. Additional binding families are explicitly deferred
Exact requirement:
“Scalar, tuple, array, FOR, GROUP, and free-object bindings remain on their existing paths until a later decision.”
Reference:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0065-first-class-object-binding-identity.md:16
These are not implicitly covered by the object-SELECT first increment.
C. Pointer traversal and scalar projection
ADR 0066 turns ADR 0061’s local identity problem into a general lowering rule.
C1. Pointer-row lowering owns identity deduplication
Exact requirement:
“Pointer-row lowering will own traversal and deduplication by target object identity.”
Reference:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0066-preserve-object-identity-until-scalar-projection.md:13-15
C2. Deduplicate before scalar projection
Exact requirement:
“A migrated lowering slice must establish the logical object set before projecting scalar values from it.”
Reference:
- Same file, line 15.
Semantic order:
1. Traverse edges.
2. Deduplicate by target identity.
3. Project the scalar.
4. Preserve one scalar occurrence per distinct target object.
C3. Ban scalar DISTINCT as an identity substitute
Exact requirement:
“Consumers must not use DISTINCT on the projected scalar as a substitute for object identity…”
Reference:
- Same file, line 15.
The generic current branch still does this:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/src/sql/gel_ir_compiler.ts:4862
C4. Ban raw edge multiplicity escaping to consumers
Exact requirement:
“…and they must not receive raw edge multiplicity and reconstruct object identity themselves.”
Reference:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0066-preserve-object-identity-until-scalar-projection.md:15
Identity semantics must live at the pointer-row boundary, not separately in selection, aggregation, predicates, and shape projection.
C5. Incremental migration must delete old workarounds
Exact requirement:
“Each slice must replace and delete its consumer-specific identity workaround rather than add another parallel identity signal.”
Reference:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0066-preserve-object-identity-until-scalar-projection.md:19
The binding-specific binding: namespace check at gel_ir_compiler.ts:4858 should therefore be viewed as a transitional workaround, not the destination.
C6. All consumer families eventually share the same rows
Exact requirement:
“Aggregates, predicates, and shapes consume the same identity-preserving row semantics as direct selection as their slices migrate.”
Reference:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0066-preserve-object-identity-until-scalar-projection.md:23-26
C7. Required minimal regression
Exact requirement:
“The minimal regression case is three edges reaching two target identities whose scalar values are equal: the result contains two scalar rows, not one or three.”
Reference:
- Same file, line 26.
This single case distinguishes:
- Wrong scalar dedup: 1 row.
- Correct identity dedup: 2 rows.
- Wrong raw-edge behavior: 3 rows.
D. Relation path-resolution migration
D1. Relation’s authority is intentionally narrow
Exact boundary:
“Relation owns path provider and aspect resolution only.”
and:
“successful path resolution must never be treated as permission to factor.”
Reference:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0064-relation-path-resolution-authority.md:9-11
ADR 0066 reiterates that Relation does not own object-set semantics:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0066-preserve-object-identity-until-scalar-projection.md:11-17
D2. Continue migration slice-by-slice
ADR 0064 is titled “for migrated lowering slices,” and source comments explicitly preserve an unmigrated frontier:
“Other source kinds have not migrated yet and keep the existing lowering until they can move as a complete slice.”
Reference:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/src/sql/gel_ir_compiler.ts:6365-6368
Each future slice should register paths when introducing range variables and resolve them through Relation, rather than reintroducing ad hoc option channels.
D3. Preserve aspect distinctions
Exact mapping:
- Exact row: source
- json_each element: iterator
- Object identity: identity
- Fresh type reference: type-plus-namespace scope key
Reference:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0064-relation-path-resolution-authority.md:9
Aspect implementation:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/src/sql/relation.ts:39-48
D4. Aggregate visibility remains stricter than ordinary resolution
Exact requirement:
“Ordinary and enclosing source scopes remain path-resolvable but are not aggregate-visible, so a free count(Type) inside an inlined function still counts the full extent.”
Reference:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0064-relation-path-resolution-authority.md:13
D5. Construct-local metadata stays local
Exact boundary:
“FOR tuple slots, link properties, and GROUP row projections retain construct-local lowering maps or semantic projection metadata.”
Reference:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0064-relation-path-resolution-authority.md:15
They must not become competing generic path authorities.
E. Pointer-path implementation consolidation
ADR 0068 is a relevant follow-on, although currently untracked.
Exact requirements:
“Each migrated path family will have exactly one semantic implementation.”
“The other route must either adapt losslessly into that implementation or stop at an explicit unsupported frontier before performing semantic interpretation.”
“It must not partially interpret a path and then silently fall back to a second implementation.”
“once migrated and covered, the redundant semantic branch is deleted.”
References:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0068-one-semantic-path-implementation-per-family.md:13-19
Required parity facts include:
“compound type structure, PathIds, carried shapes, and binding identity”
Reference:
- Same file, lines 21–26.
Current deferred qlast frontiers include:
- Binding-rooted paths carrying query shapes.
- Computed-property in-place lowering.
- Group-row fields.
- Named-tuple access.
- Polymorphic link properties.
- Untyped/scalar backlinks.
References:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/src/compiler/qlast_setgen.ts:8-13
- /Users/noahlopez/Development/Github/gel/sqlite-ts/src/compiler/qlast_setgen.ts:190-200
- /Users/noahlopez/Development/Github/gel/sqlite-ts/src/compiler/qlast_setgen.ts:231-268
- /Users/noahlopez/Development/Github/gel/sqlite-ts/src/compiler/ast_to_qlast.ts:12-15
Architectural constraint: do not create false pointer_nav or shape_compiler module seams:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0040-pointer-navigation-stays-in-ast-to-ir.md
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0041-shape-compiler-stays-in-ast-to-ir.md
F. ADR 0063’s unrelated deferred item
ADR 0063 is not about the requested identity/path themes, but it has one explicit deferred requirement:
“Widening the type to ScalarValue | ScalarValue[] | undefined (removing the cast) is a follow-up.”
References:
- /Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0063-extract-exclusive-conflict-detection.md:80-84
- Narrow signature: /Users/noahlopez/Development/Github/gel/sqlite-ts/src/runtime/conflict_detection.ts:218-225
- Remaining cast: /Users/noahlopez/Development/Github/gel/sqlite-ts/src/runtime/engine.ts:9197-9204
2. Primary ADR/file reference map
Topic	Primary references
Shared-prefix factoring	/Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0061-shared-prefix-count-factoring.md
Scope-tree serialization/convergence	/Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0062-scope-tree-pformat-and-prune-ir-analysis.md
Conflict-probe type follow-up	/Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0063-extract-exclusive-conflict-detection.md
Relation authority and boundaries	/Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0064-relation-path-resolution-authority.md
Object binding identity	/Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0065-first-class-object-binding-identity.md
Identity-before-scalar-projection rule	/Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0066-preserve-object-identity-until-scalar-projection.md
Binding/scope vocabulary	/Users/noahlopez/Development/Github/gel/sqlite-ts/CONTEXT.md:31-33, 57-63, 121-123
Factoring authority implementation	/Users/noahlopez/Development/Github/gel/sqlite-ts/src/ir/scope_tree.ts
Scope-tree construction	/Users/noahlopez/Development/Github/gel/sqlite-ts/src/ir/scope_builder.ts
Pointer scalar workaround	/Users/noahlopez/Development/Github/gel/sqlite-ts/src/sql/gel_ir_compiler.ts:4821-4862
Relation implementation	/Users/noahlopez/Development/Github/gel/sqlite-ts/src/sql/relation.ts
Object-binding IR	/Users/noahlopez/Development/Github/gel/sqlite-ts/src/ir/gel_ir.ts:156-186, 205-230, 380-384
Object-binding construction	/Users/noahlopez/Development/Github/gel/sqlite-ts/src/compiler/ast_to_ir.ts:2133-2326
Object-binding SQL resolution	/Users/noahlopez/Development/Github/gel/sqlite-ts/src/sql/gel_ir_compiler.ts:6184-6293
Path migration constraint	/Users/noahlopez/Development/Github/gel/sqlite-ts/docs/adr/0068-one-semantic-path-implementation-per-family.md
Failure inventory	/Users/noahlopez/Development/Github/gel/sqlite-ts/failing-query-groups.md
Adjacent object-identity failures worth retaining as regression candidates:
- Object identity lost through array_agg/array_unpack: /Users/noahlopez/Development/Github/gel/sqlite-ts/failing-query-groups.md:1299-1332
- Object identity/shape lost inside arrays: /Users/noahlopez/Development/Github/gel/sqlite-ts/failing-query-groups.md:1532-1567
- Object tuple element loses identity before reshaping: /Users/noahlopez/Development/Github/gel/sqlite-ts/failing-query-groups.md:1787-1804
- Bound object equality not recognized as identity comparison: /Users/noahlopez/Development/Github/gel/sqlite-ts/failing-query-groups.md:6989-7041
These are broader than ADR 0066’s pointer-row rule but exercise the same “retain identity until the consumer no longer needs it” principle.
3. Likely acceptance criteria
Factoring/scope tree
1. SELECT count((Card.name, Card.cost)) returns 9.
2. WITH U := User { cards := Card } SELECT count((U.cards.name, U.cards.cost)) returns 81.
3. The same verdicts come directly from analyzeTreeFactoring; the tuple stamp and isWithBinding special gate are removed or become mere outputs of that single authority.
4. Pointer-prefix collapse deduplicates target IDs before counting.
5. scope_computables_07a, 07c, and 08 return 81, 0, and 16.
6. Scope-tree formatting uses real typed PathIds and matches Gel scope-tree goldens, not only sqlite-ts structural sig: names.
7. No factoring decision is inferred from successful Relation lookup.
Object binding identity
 1. Live IR contains one statement-owned binding definition with an opaque ID; every reference to that binding uses that ID.
 2. Shadowed bindings with equal names receive different IDs.
 3. Binding definitions preserve shape, filter, order, limit, and offset.
 4. Unsupported binding shapes fail explicitly rather than degrading to a type root.
 5. Repeated reads refer to the same semantic binding source while retaining EdgeQL’s intended independent-iteration/cross-product behavior.
 6. Runtime-generated captures use the same IR representation.
 7. The 9/81 factoring tests remain unchanged.
 8. Filtered object bindings such as scope_computables_07c preserve their filter.
 9. bindingAst and shape-reconstruction paths are removed once their facts are represented directly.
10. Scalar, tuple, array, FOR, GROUP, and free-object bindings remain behaviorally unchanged until explicitly migrated.
Pointer identity before scalar projection
1. Given three edges to target IDs {A, A, B}, with A.scalar == B.scalar, direct scalar projection produces two equal scalar rows.
2. count(pointer.scalar) produces 2, not 1 or 3.
3. Selection, aggregate, predicate, and shape consumers all observe the same logical object set.
4. SQL performs identity dedup before scalar projection; no migrated branch emits SELECT DISTINCT scalar as the identity mechanism.
5. Raw edge rows do not escape pointer-row lowering.
6. Each migrated slice deletes its previous consumer-specific workaround, including namespace-based identity exceptions.
7. Physical SQL shape may differ by slice, but semantic ordering remains traversal → target-ID dedup → scalar projection.
Relation migration
1. New range variables register all relevant path/aspect providers in Relation.
2. Migrated code resolves paths exclusively via Relation; removed channels such as outerScopes, sourcePathAliases, multiScalarBindings, and scopedAggRoot remain absent.
3. source, identity, iterator, value, and serialized aspects remain distinct.
4. Child scopes shadow parent scopes; recursive column injection is idempotent.
5. Aggregate lookup consumes only locally registered aggregate scope, not ordinary/enclosing scope.
6. FOR tuple slots, link properties, and GROUP projections remain construct-local.
7. A successful provider lookup never changes factoring or object-set semantics.
Pointer-path implementation migration
1. Each migrated path family has one semantic implementation.
2. The adapter either preserves PathIds, compound types, carried shapes, and binding identity or rejects the family before interpretation.
3. No partial qlast interpretation followed by silent direct-compiler reinterpretation.
4. Differential tests compare full downstream-relevant facts, not only a pointer-chain signature.
5. Completion of a family includes deleting its redundant branch.
6. No new cyclic pointer_nav or shape_compiler module is introduced.
ADR 0063 follow-up
1. planExclusiveConflictProbe accepts ScalarValue | ScalarValue[] | undefined.
2. The as unknown as ScalarValue cast in engine.ts is removed.
3. Existing single- and multi-property conflict-probe tests remain behaviorally unchanged.