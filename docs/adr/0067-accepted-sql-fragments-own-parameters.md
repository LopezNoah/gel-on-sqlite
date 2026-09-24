# Accepted SQL fragments own their parameters

## Status

Accepted.

## Context

The SQL compiler currently couples placeholder values to compilation order through a shared mutable `params` array. That is only sound when fragments are emitted once and in the order they were compiled. Speculative compilation, rejected alternatives, and composition that emits fragments in a different order can leave parameters behind or pair the right number of placeholders with the wrong values.

ADR 0058 introduced `SqlFragment { sql, params }` as the destination type and `bindOperandsOnce` as a safe first slice, while explicitly deferring the full ownership conversion because an all-at-once rewrite would be too broad and risky.

## Decision

For each migrated lowering slice, the compositional unit is an owned SQL fragment: its SQL text and ordered parameters travel together. Fragment composition determines parameter order from final SQL emission order, not from the order in which candidate fragments happened to compile. Accepting a fragment contributes both its SQL and parameters; rejecting speculative work contributes neither.

Migration will be incremental. A converted slice may adapt to the legacy shared parameter array only at its outer boundary, after its final fragment has been selected and composed. Checkpoints, slices, and manual rollback inside that slice must be removed rather than retained as a second ownership mechanism. `bindOperandsOnce` remains the rule when one parameterized operand must be evaluated once and referenced repeatedly.

## Consequences

- Reordering composed fragments also reorders their parameters correctly.
- Failed or unsupported speculative branches cannot leak parameters into the accepted artifact.
- Tests for migrated slices assert parameter values and order, not only placeholder and parameter counts.
- The compiler temporarily contains owned-fragment and legacy-array regions, but each migrated slice has one explicit adaptation boundary.
- This continues ADR 0058; it does not attempt the deferred all-at-once conversion of every compile function.

## Considered options

- Keeping the shared array and adding more checkpoints or rollback was rejected because correctness would still depend on every branch remembering mutable global history.
- Treating compile order as emission order was rejected because SQL composition legitimately emits fragments in a different structural order.
- Converting the entire SQL compiler in one change was rejected because partial mistakes become silent positional binding errors and the migration can be safely sliced.
