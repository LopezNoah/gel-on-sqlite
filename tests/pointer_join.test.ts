import { describe, expect, it } from "vitest";
import { quoteIdent } from "../src/codegen/sql.js";
import { pointerStepJoinSql } from "../src/sql/pointer_join.js";

const id = quoteIdent("id");
// A target source carries its own alias, as the call sites build it.
const TS = `${quoteIdent("default__user")} p1`;

const base = { previousAlias: "p0", nextAlias: "p1", targetSource: TS } as const;

describe("pointerStepJoinSql — junction-table step", () => {
  it("outbound: junction.source = prev.id, target.id = junction.target", () => {
    expect(
      pointerStepJoinSql({ ...base, usesLinkTable: true, direction: "outbound", linkAlias: "pj0", linkTable: "lk" }),
    ).toBe(
      ` JOIN ${quoteIdent("lk")} pj0 ON pj0.${quoteIdent("source")} = p0.${id}`
      + ` JOIN ${TS} ON p1.${id} = pj0.${quoteIdent("target")}`,
    );
  });

  it("inbound (backlink): junction.target = prev.id, target.id = junction.source", () => {
    expect(
      pointerStepJoinSql({ ...base, usesLinkTable: true, direction: "inbound", linkAlias: "pj0", linkTable: "lk" }),
    ).toBe(
      ` JOIN ${quoteIdent("lk")} pj0 ON pj0.${quoteIdent("target")} = p0.${id}`
      + ` JOIN ${TS} ON p1.${id} = pj0.${quoteIdent("source")}`,
    );
  });
});

describe("pointerStepJoinSql — inline-FK step", () => {
  it("outbound: target.id = prev.<fk>", () => {
    expect(
      pointerStepJoinSql({ ...base, usesLinkTable: false, direction: "outbound", inlineColumn: "owner_id" }),
    ).toBe(` JOIN ${TS} ON p1.${id} = p0.${quoteIdent("owner_id")}`);
  });

  it("inbound (backlink): target.<fk> = prev.id", () => {
    expect(
      pointerStepJoinSql({ ...base, usesLinkTable: false, direction: "inbound", inlineColumn: "author_id" }),
    ).toBe(` JOIN ${TS} ON p1.${quoteIdent("author_id")} = p0.${id}`);
  });
});

describe("pointerStepJoinSql — direction defaulting", () => {
  it("treats any non-'inbound' direction as outbound (matches the inline call sites)", () => {
    const out = pointerStepJoinSql({ ...base, usesLinkTable: false, direction: "outbound", inlineColumn: "x_id" });
    const other = pointerStepJoinSql({ ...base, usesLinkTable: false, direction: "whatever", inlineColumn: "x_id" });
    expect(other).toBe(out);
  });
});
