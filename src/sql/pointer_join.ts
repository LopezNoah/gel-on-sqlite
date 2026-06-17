// The one home for a pointer step's JOIN wiring. Lowering a pointer chain
// (`User.posts.author.name`) to SQL means, for each step, joining the next
// type's rows onto the previous step's alias. There are exactly four shapes,
// depending on how the link is stored and which way it points:
//
//   junction, outbound:  JOIN <link> lj ON lj.source = prev.id
//                        JOIN <target> nx ON nx.id = lj.target
//   junction, inbound:   JOIN <link> lj ON lj.target = prev.id
//                        JOIN <target> nx ON nx.id = lj.source
//   inline,   outbound:  JOIN <target> nx ON nx.id = prev.<fk>
//   inline,   inbound:   JOIN <target> nx ON nx.<fk> = prev.id
//
// This wiring was re-derived inline across ~9 lowering functions in
// `gel_ir_compiler.ts`, differing only in alias names — the kind of shallow
// spread the round-3 review flagged. `pointerStepJoinSql` is the single
// definition; the callers supply the aliases and the already-compiled target
// source (a polymorphic-source subquery, or a plain `"table" alias`) that vary
// with context. The first-step FROM construction and the terminal junction-only
// join stay with their callers — those are context-specific, not this primitive
// (see docs/adr/0011). Depends only on `quoteIdent` (a leaf), so no lowering
// cycle and a real unit-test surface (`tests/pointer_join.test.ts`).
import { quoteIdent } from "../codegen/sql.js";

export interface PointerStepJoin {
  // A separate junction table (multi or link-with-properties) vs. an inline
  // `<name>_id` FK column.
  usesLinkTable: boolean;
  // "inbound" = a backlink (`.<link`); anything else is treated as outbound,
  // matching the inline call sites' `direction === "inbound" ? … : …`.
  direction: string;
  // The alias of the previous step (correlated on `.id`).
  previousAlias: string;
  // The alias introduced by this step (the joined target rows).
  nextAlias: string;
  // The already-compiled FROM fragment for the target, carrying `nextAlias`
  // (e.g. a polymorphic-source subquery `(…) p1`, or `"default__user" p1`).
  targetSource: string;
  // Junction-table case: the junction alias and table name.
  linkAlias?: string;
  linkTable?: string;
  // Inline-FK case: the `<name>_id` column on whichever side holds it.
  inlineColumn?: string;
}

// The JOIN fragment for one non-terminal pointer step, leading-space-prefixed so
// it appends directly onto a FROM clause. Byte-for-byte equal to the inline form
// the call sites used.
export const pointerStepJoinSql = (step: PointerStepJoin): string => {
  const { direction, previousAlias, nextAlias, targetSource } = step;
  const inbound = direction === "inbound";
  const prevId = `${previousAlias}.${quoteIdent("id")}`;

  if (step.usesLinkTable) {
    const { linkAlias, linkTable } = step;
    const onPrev = inbound ? "target" : "source";
    const onTarget = inbound ? "source" : "target";
    return (
      ` JOIN ${quoteIdent(linkTable!)} ${linkAlias}`
      + ` ON ${linkAlias}.${quoteIdent(onPrev)} = ${prevId}`
      + ` JOIN ${targetSource}`
      + ` ON ${nextAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent(onTarget)}`
    );
  }

  const inlineColumn = step.inlineColumn!;
  return inbound
    ? ` JOIN ${targetSource} ON ${nextAlias}.${quoteIdent(inlineColumn)} = ${prevId}`
    : ` JOIN ${targetSource} ON ${nextAlias}.${quoteIdent("id")} = ${previousAlias}.${quoteIdent(inlineColumn)}`;
};

// The one home for the pointer-chain SQL alias scheme — the naming sibling of
// `pointerStepJoinSql`. A pointer path lowers to a FROM seeded at the root
// alias, then one JOIN per step; step `i` (0-based) joins through link alias
// `pj{i}` onto target alias `p{i+1}`. The three pointer-path lowerings in
// `gel_ir_compiler.ts` (the scalar path, its correlated variant, and the
// reversed-links link-property path) each re-spelled this scheme inline, so a
// change to it meant editing three places that had to agree. They now share
// these helpers. The well-known single-scope anchor aliases (`g0`/`j0`/`t0`)
// and the single-use indexed families (cp/oe/sg/…) are deliberately left inline
// — they are not this scheme, and an opaque counter would change every alias
// string and break the anchors referenced by literal (see docs/adr/0022).
export const POINTER_ROOT_ALIAS = "p0";
export const pointerStepTargetAlias = (stepIndex: number): string => `p${stepIndex + 1}`;
export const pointerStepLinkAlias = (stepIndex: number): string => `pj${stepIndex}`;
