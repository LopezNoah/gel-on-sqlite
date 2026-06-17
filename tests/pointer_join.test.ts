import { describe, expect, it } from "vitest";
import { quoteIdent } from "../src/codegen/sql.js";
import {
  POINTER_ROOT_ALIAS,
  pointerStepJoinSql,
  pointerStepLinkAlias,
  pointerStepTargetAlias,
} from "../src/sql/pointer_join.js";

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

describe("pointer-chain alias scheme", () => {
  it("root is p0; step i joins through pj{i} onto p{i+1}", () => {
    expect(POINTER_ROOT_ALIAS).toBe("p0");
    expect(pointerStepLinkAlias(0)).toBe("pj0");
    expect(pointerStepTargetAlias(0)).toBe("p1");
    expect(pointerStepLinkAlias(1)).toBe("pj1");
    expect(pointerStepTargetAlias(1)).toBe("p2");
  });

  it("reproduces the exact aliases the join builder is exercised with", () => {
    // The `base` fixture above (p0 → p1 via pj0) is step 0 of a chain rooted
    // at POINTER_ROOT_ALIAS — the scheme and the join builder must agree.
    expect(base.previousAlias).toBe(POINTER_ROOT_ALIAS);
    expect(base.nextAlias).toBe(pointerStepTargetAlias(0));
    expect("pj0").toBe(pointerStepLinkAlias(0));
  });

  it("target and link aliases never collide across steps", () => {
    const seen = new Set<string>([POINTER_ROOT_ALIAS]);
    for (let i = 0; i < 8; i += 1) {
      for (const a of [pointerStepLinkAlias(i), pointerStepTargetAlias(i)]) {
        expect(seen.has(a)).toBe(false);
        seen.add(a);
      }
    }
  });
});
