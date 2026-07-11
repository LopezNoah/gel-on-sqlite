import { describe, expect, it } from "vitest";
import { parseEdgeQL } from "../src/edgeql/parser.js";
import { buildScopeTreeFromAst } from "../src/ir/scope_builder.js";
import { formatScopeTree } from "../src/ir/scope_tree_format.js";

// The scope tree's golden surface (sibling to tests/edgeql_ir_pathid.test.ts,
// which pins PathId.toString() against Gel's pathid.py pformat). Where
// scope_builder.test.ts asserts tree shape with a bespoke countByName/seg walk,
// here we pin the canonical scopetree.py-style FENCE serialization, so a golden
// changes only when the tree shape changes — and the correlated-vs-factored
// discriminator (ADR 0061) is legible in the output: a CORRELATED prefix fuses
// to a single path node, a FACTORED one splits per occurrence (vns1 / vns2).
//
// NOTE: the populated tree carries STRUCTURAL `sig:` path ids (segment chains,
// no derived names), so paths render as `(Card.name)` rather than Gel's
// `(default::Card).>name[IS std::str]`. The FENCE/BRANCH SHAPE matches Gel; the
// derived NAMES follow once real PathIds are wired into the tree (the layer-3
// convergence deferred by ADR 0061). The serializer already routes real paths
// through pathid_format.ts, so that lands with no change here.

const pformat = (q: string): string => {
  const ast = parseEdgeQL(q) as unknown;
  const stmt = Array.isArray(ast) ? ast[0] : ast;
  return formatScopeTree(buildScopeTreeFromAst(stmt));
};

describe("scope_tree_format (scopetree.py pformat)", () => {
  it("CORRELATED: (Card.name, Card.cost) fuses at a single Card node", () => {
    expect(pformat("SELECT count((Card.name, Card.cost))")).toBe(
      [
        '"FENCE uid:2": {',
        '    "(Card) uid:3": {',
        '        "(Card.name) uid:4",',
        '        "(Card.cost) uid:5"',
        "    }",
        "}",
      ].join("\n"),
    );
  });

  it("FACTORED: a WITH-alias view computable splits U.cards per occurrence", () => {
    expect(
      pformat("WITH U := User { cards := Card }, SELECT count((U.cards.name, U.cards.cost))"),
    ).toBe(
      [
        '"FENCE uid:2": {',
        '    "FENCE uid:3": {',
        '        "(User) uid:4"',
        "    },",
        '    "(U) uid:5": {',
        '        "vns1@@(U.cards) uid:6": {',
        '            "vns1@@(U.cards.name) uid:7"',
        "        },",
        '        "vns2@@(U.cards) uid:8": {',
        '            "vns2@@(U.cards.cost) uid:9"',
        "        }",
        "    }",
        "}",
      ].join("\n"),
    );
  });

  it("FOR binding + double SELECT: fences the iterator body, fuses the binding refs", () => {
    expect(
      pformat(
        "WITH Y := (FOR x IN {1, 2} UNION (x + 1)), SELECT _ := ((SELECT Y), (SELECT Y)) ORDER BY _",
      ),
    ).toBe(
      [
        '"FENCE uid:2": {',
        '    "FENCE uid:3": {',
        '        "BRANCH uid:4": {',
        '            "(x) uid:5"',
        "        }",
        "    },",
        '    "(Y) uid:6",',
        '    "(_) uid:7"',
      ].join("\n") + "\n}",
    );
  });

  // The serialization makes the ADR-0061 discriminator a one-line assertion: the
  // CORRELATED tree names `(Card)` once; the FACTORED tree names `U.cards` twice.
  it("the pformat exposes the correlated-vs-factored split", () => {
    const correlated = pformat("SELECT count((Card.name, Card.cost))");
    const factored = pformat(
      "WITH U := User { cards := Card }, SELECT count((U.cards.name, U.cards.cost))",
    );
    expect(correlated.match(/\(Card\) uid/g)?.length).toBe(1);
    expect(factored.match(/\(U\.cards\) uid/g)?.length).toBe(2);
  });
});
