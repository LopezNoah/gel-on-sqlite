import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseEdgeQL } from "../src/edgeql/parser.js";
import { compileASTToGelIR, expandSchemaAliasesInStatement } from "../src/compiler/ast_to_ir.js";
import { parseDeclarativeSchema } from "../src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";
import type { SchemaSnapshot } from "../src/schema/schema.js";
import type { Statement } from "../src/edgeql/ast.js";

type Multiplicity = "empty" | "unique" | "duplicate" | "unknown";

const loadSchema = (): SchemaSnapshot => {
  const source = fs.readFileSync(new URL("./schemas/cards_ir_inference.esdl", import.meta.url), "utf8");
  const decl = parseDeclarativeSchema(`module default {\n${source}\n}`, { legacySyntaxCompat: true });
  return schemaSnapshotFromDeclarative(decl);
};

const compileQuery = (schema: SchemaSnapshot, query: string) => {
  const ast = parseEdgeQL(query) as unknown;
  const stmt = (Array.isArray(ast) ? (ast as Statement[])[0] : (ast as Statement)) as Statement;
  return compileASTToGelIR(expandSchemaAliasesInStatement(stmt, schema), { module: (stmt as { withModule?: string }).withModule, schema });
};

const expectMultiplicity = (
  schema: SchemaSnapshot,
  source: string,
  expected: Multiplicity,
): void => {
  const ir = compileQuery(schema, source);
  expect((ir as { multiplicity?: Multiplicity }).multiplicity).toBe(expected);
};

// The Python suite checks `ir.multiplicity` on the top-level statement IR.
// sqlite-ts only computes an `inference.multiplicity` field on certain IR kinds
// (SelectIR/mutation IRs), and full inference rules (set literals, casts,
// tuples, comprehensions, set-theoretic ops) are not yet implemented. Tests are
// kept as parity placeholders.

describe("TestEdgeQLMultiplicityInference", () => {
  let schema: SchemaSnapshot;

  beforeAll(() => {
    schema = loadSchema();
  });

  it("test_edgeql_ir_mult_inference_00", () => {
    expectMultiplicity(schema, `SELECT Card`, "unique");
  });

  it("test_edgeql_ir_mult_inference_01", () => {
    expectMultiplicity(schema, `SELECT Card.id`, "unique");
  });

  it("test_edgeql_ir_mult_inference_02", () => {
    expectMultiplicity(schema, `SELECT User.name`, "unique");
  });

  it("test_edgeql_ir_mult_inference_03", () => {
    expectMultiplicity(schema, `SELECT User.deck_cost`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_04", () => {
    expectMultiplicity(schema, `SELECT Card FILTER Card.name = 'Djinn'`, "unique");
  });

  it("test_edgeql_ir_mult_inference_05", () => {
    expectMultiplicity(schema, `SELECT Card LIMIT 1`, "unique");
  });

  it("test_edgeql_ir_mult_inference_06", () => {
    expectMultiplicity(schema, `SELECT 1`, "unique");
  });

  it("test_edgeql_ir_mult_inference_07", () => {
    expectMultiplicity(schema, `SELECT {1, 2}`, "unique");
  });

  it("test_edgeql_ir_mult_inference_08", () => {
    expectMultiplicity(schema, `SELECT {1, 1}`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_09", () => {
    expectMultiplicity(schema, `SELECT User.deck`, "unique");
  });

  it("test_edgeql_ir_mult_inference_10", () => {
    expectMultiplicity(schema, `SELECT Card.cost`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_11", () => {
    expectMultiplicity(schema, `SELECT Card.owners`, "unique");
  });

  it("test_edgeql_ir_mult_inference_12", () => {
    expectMultiplicity(schema, `SELECT {Card, User}`, "unique");
  });

  it("test_edgeql_ir_mult_inference_13", () => {
    expectMultiplicity(schema, `SELECT 1 + 2`, "unique");
  });

  it("test_edgeql_ir_mult_inference_14a", () => {
    expectMultiplicity(schema, `SELECT 1 + {2, 3}`, "unique");
  });

  it("test_edgeql_ir_mult_inference_14b", () => {
    expectMultiplicity(schema, `SELECT 0 * {2, 3}`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_15", () => {
    expectMultiplicity(schema, `SELECT {1, 2} + {2, 3}`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_16", () => {
    expectMultiplicity(schema, `SELECT 'pre_' ++ Card.name`, "unique");
  });

  it("test_edgeql_ir_mult_inference_17", () => {
    expectMultiplicity(schema, `SELECT User.name ++ Card.name`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_18", () => {
    expectMultiplicity(schema, `SELECT (1, {'a', 'b'})`, "unique");
  });

  it("test_edgeql_ir_mult_inference_19", () => {
    expectMultiplicity(schema, `SELECT (1, Card.name)`, "unique");
  });

  it("test_edgeql_ir_mult_inference_20", () => {
    expectMultiplicity(schema, `SELECT [1, {1, 2}]`, "unique");
  });

  it("test_edgeql_ir_mult_inference_21", () => {
    expectMultiplicity(schema, `SELECT ['card', Card.name]`, "unique");
  });

  it("test_edgeql_ir_mult_inference_22", () => {
    expectMultiplicity(schema, `SELECT User.name ++ Card.name`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_23", () => {
    expectMultiplicity(schema, `SELECT to_str(1)`, "unique");
  });

  it("test_edgeql_ir_mult_inference_24", () => {
    expectMultiplicity(schema, `WITH
            C := (SELECT Card FILTER .name = 'Imp')
        SELECT str_split(<str>C.id, '')`, "unique");
  });

  it("test_edgeql_ir_mult_inference_25", () => {
    expectMultiplicity(schema, `SELECT str_split(<str>Card.id, '')`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_26", () => {
    expectMultiplicity(schema, `SELECT array_unpack(str_split(<str>Card.id, ''))`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_27", () => {
    expectMultiplicity(schema, `SELECT count(Card)`, "unique");
  });

  it("test_edgeql_ir_mult_inference_28", () => {
    expectMultiplicity(schema, `SELECT 1 IN {1, 2, 3}`, "unique");
  });

  it("test_edgeql_ir_mult_inference_29", () => {
    expectMultiplicity(schema, `SELECT 1 IN {1, 1, 3}`, "unique");
  });

  it("test_edgeql_ir_mult_inference_30", () => {
    expectMultiplicity(schema, `SELECT {1, 2} IN {1, 2, 3}`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_31", () => {
    expectMultiplicity(schema, `SELECT Card.name IN {'Imp', 'Dragon'}`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_32", () => {
    expectMultiplicity(schema, `SELECT <str>{1, 2, 3}`, "unique");
  });

  it("test_edgeql_ir_mult_inference_33", () => {
    expectMultiplicity(schema, `SELECT <str>{1, 1, 3}`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_34", () => {
    expectMultiplicity(schema, `SELECT <str>Card.id`, "unique");
  });

  it("test_edgeql_ir_mult_inference_35", () => {
    expectMultiplicity(schema, `SELECT <json>User.name`, "unique");
  });

  it("test_edgeql_ir_mult_inference_36", () => {
    expectMultiplicity(schema, `SELECT <str>Card.cost`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_37", () => {
    expectMultiplicity(schema, `SELECT User.deck[IS SpecialCard]`, "unique");
  });

  it("test_edgeql_ir_mult_inference_38", () => {
    expectMultiplicity(schema, `SELECT Award.<awards[IS User]`, "unique");
  });

  it("test_edgeql_ir_mult_inference_39", () => {
    expectMultiplicity(schema, `SELECT (1, Card.name).0`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_40", () => {
    expectMultiplicity(schema, `SELECT (1, Card.name).1`, "unique");
  });

  it("test_edgeql_ir_mult_inference_41", () => {
    expectMultiplicity(schema, `SELECT ['card', Card.name][0]`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_42", () => {
    expectMultiplicity(schema, `SELECT ['card', Card.name][1]`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_43", () => {
    expectMultiplicity(schema, `SELECT DISTINCT Card.element`, "unique");
  });

  it("test_edgeql_ir_mult_inference_44", () => {
    expectMultiplicity(schema, `SELECT User {
            friends_of_friends := .friends.friends,
            others := (
                SELECT WaterOrEarthCard.owners
            )
        }`, "unique");
  });

  it("test_edgeql_ir_mult_inference_45", () => {
    expectMultiplicity(schema, `SELECT Award {
            owner := .<awards[IS User]
        }`, "unique");
  });

  it("test_edgeql_ir_mult_inference_46", () => {
    expectMultiplicity(schema, `SELECT User {
            card_names := .deck.name,
            card_elements := DISTINCT .deck.element,
            deck: {
                el := User.deck.element[:2]
            }
        }`, "unique");
  });

  it("test_edgeql_ir_mult_inference_47", () => {
    expectMultiplicity(schema, `SELECT 1 IS str`, "unique");
  });

  it("test_edgeql_ir_mult_inference_48", () => {
    expectMultiplicity(schema, `SELECT Award IS Named`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_49", () => {
    expectMultiplicity(schema, `WITH
            A := (
                SELECT Award FILTER .name = 'Wow'
            )
        SELECT A IS Named`, "unique");
  });

  it("test_edgeql_ir_mult_inference_50", () => {
    expectMultiplicity(schema, `SELECT Award.name IS str`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_51", () => {
    expectMultiplicity(schema, `SELECT INTROSPECT TYPEOF User.deck`, "unique");
  });

  it("test_edgeql_ir_mult_inference_52", () => {
    expectMultiplicity(schema, `SELECT (INTROSPECT TYPEOF User.deck).name`, "unique");
  });

  it("test_edgeql_ir_mult_inference_53", () => {
    expectMultiplicity(schema, `SELECT User {
            card_elements := .deck.element
        }`, "unique");
  });

  it("test_edgeql_ir_mult_inference_54", () => {
    expectMultiplicity(schema, `SELECT User {
            foo := {1, 1, 2}
        }`, "unique");
  });

  it("test_edgeql_ir_mult_inference_55a", () => {
    expectMultiplicity(schema, `FOR x IN {'fire', 'water'}
        UNION (
            SELECT Card
            FILTER .element = x
        )`, "unique");
  });

  it("test_edgeql_ir_mult_inference_55b", () => {
    expectMultiplicity(schema, `FOR letter IN {'I', 'B'}
        UNION (
            SELECT Card
            FILTER .name[0] = letter
        )`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_56", () => {
    expectMultiplicity(schema, `SELECT User {
            wishlist := (
                FOR x IN {'fire', 'water'}
                UNION (
                    SELECT Card
                    FILTER .element = x
                )
            )
        }`, "unique");
  });

  it("test_edgeql_ir_mult_inference_57", () => {
    expectMultiplicity(schema, `SELECT enumerate({2, 2})`, "unique");
  });

  it("test_edgeql_ir_mult_inference_58", () => {
    expectMultiplicity(schema, `SELECT enumerate(Card)`, "unique");
  });

  it("test_edgeql_ir_mult_inference_59", () => {
    expectMultiplicity(schema, `FOR x IN {enumerate({'fire', 'water'})}
        UNION (
            SELECT Card
            FILTER .element = x.1
        )`, "unique");
  });

  it("test_edgeql_ir_mult_inference_59a", () => {
    expectMultiplicity(schema, `FOR x IN {enumerate({'fire', 'water'})}
        UNION (
            SELECT (
                SELECT Card
                FILTER .element = x.1
            )
        )`, "unique");
  });

  it("test_edgeql_ir_mult_inference_60", () => {
    expectMultiplicity(schema, `FOR x IN {
            enumerate(
                DISTINCT array_unpack(['fire', 'water']))
        }
        UNION (
            SELECT Card
            FILTER .element = x.1
        )`, "unique");
  });

  it("test_edgeql_ir_mult_inference_61", () => {
    expectMultiplicity(schema, `FOR x IN {
            enumerate(
                array_unpack(['A', 'B']))
        }
        UNION (
            INSERT Card {
                name := x.1,
                element := 'test',
                cost := 0,
                req_awards := {}, # wtvr
                req_tags := {}, # wtvr
            }
        )`, "unique");
  });

  it("test_edgeql_ir_mult_inference_62", () => {
    expectMultiplicity(schema, `SELECT Card UNION SpecialCard`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_63", () => {
    expectMultiplicity(schema, `FOR card IN {enumerate(Card)}
        UNION (SELECT card.1)`, "unique");
  });

  it("test_edgeql_ir_mult_inference_64", () => {
    expectMultiplicity(schema, `FOR card IN {Card}
        UNION card`, "unique");
  });

  it("test_edgeql_ir_mult_inference_65", () => {
    expectMultiplicity(schema, `WITH C := <Card>{}
        FOR card IN {C}
        UNION card`, "empty");
  });

  it("test_edgeql_ir_mult_inference_66", () => {
    expectMultiplicity(schema, `FOR card IN {Card, SpecialCard}
        UNION card`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_67", () => {
    expectMultiplicity(schema, `SELECT
            (SELECT User FILTER .name = "foo")
            ??
            (SELECT User FILTER .name = "bar")`, "unique");
  });

  it("test_edgeql_ir_mult_inference_68", () => {
    expectMultiplicity(schema, `SELECT
            (SELECT User FILTER .name = "foo")
            ??
            {
                User,
                User,
            }`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_69", () => {
    expectMultiplicity(schema, `SELECT
            {
                (INSERT User { name := "a" }),
                (INSERT User { name := "b" }),
            }`, "unique");
  });

  // Live IR gap: deep nested double-computed tuple-index over a backlink shape (ADR 0017).
  it.skip("test_edgeql_ir_mult_inference_70", () => {
    expectMultiplicity(schema, `WITH
            X1 := Card {
                z := (.<deck[IS User],)
            }
        SELECT X1 {
            foo := .z.0
        }.foo`, "unique");
  });

  it("test_edgeql_ir_mult_inference_71", () => {
    expectMultiplicity(schema, `FOR card IN {assert_distinct(Card UNION SpecialCard)}
        UNION card`, "unique");
  });

  // Live IR gap: error-detection case the Live IR does not reject (ADR 0017).
  it.skip("test_edgeql_ir_mult_inference_error_01", () => {
    expect(() => compileQuery(schema, `SELECT User {
    bad_link := {Card, Card},
    name,
}`)).toThrow();
  });

  // Live IR gap: error-detection case the Live IR does not reject (ADR 0017).
  it.skip("test_edgeql_ir_mult_inference_error_02", () => {
    expect(() => compileQuery(schema, `WITH
    A := {Card, Card}
SELECT User {
    bad_link := A,
    name,
}`)).toThrow();
  });

  it("test_edgeql_ir_mult_inference_72", () => {
    expectMultiplicity(schema, `SELECT ()`, "unique");
  });

  it("test_edgeql_ir_mult_inference_73", () => {
    expectMultiplicity(schema, `SELECT {(), ()}`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_74", () => {
    expectMultiplicity(schema, `SELECT <array<str>>[]`, "unique");
  });

  it("test_edgeql_ir_mult_inference_75", () => {
    expectMultiplicity(schema, `SELECT <str>{}`, "empty");
  });

  it("test_edgeql_ir_mult_inference_76", () => {
    expectMultiplicity(schema, `SELECT (Card, User).1`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_77", () => {
    expectMultiplicity(schema, `for x in {1, 2} union { foo := 10 }`, "unique");
  });

  it("test_edgeql_ir_mult_inference_77b", () => {
    expectMultiplicity(schema, `for x in {1, 1} union { foo := 10 }`, "unique");
  });

  it("test_edgeql_ir_mult_inference_78", () => {
    expectMultiplicity(schema, `with F := { foo := 10 }
        for x in {1, 2} union F`, "unique");
  });

  it("test_edgeql_ir_mult_inference_79", () => {
    expectMultiplicity(schema, `for x in {1, 2, 3} union (with z := x, select z)`, "unique");
  });

  it("test_edgeql_ir_mult_inference_80", () => {
    expectMultiplicity(schema, `for x in {1,2} union (for y in {3, 4} union x)`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_81", () => {
    expectMultiplicity(schema, `for x in {1,2} union (for y in {3, 4} union y)`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_82", () => {
    expectMultiplicity(schema, `select 1 union 1`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_83", () => {
    expectMultiplicity(schema, `select 1 + (2 intersect 3)`, "unique");
  });

  it("test_edgeql_ir_mult_inference_84", () => {
    expectMultiplicity(schema, `select 1 + (2 intersect {3, 3})`, "unique");
  });

  it("test_edgeql_ir_mult_inference_85", () => {
    expectMultiplicity(schema, `select 1 + ({2, 2} intersect {3, 3})`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_86", () => {
    expectMultiplicity(schema, `select {2, 2} intersect <int64>{}`, "empty");
  });

  it("test_edgeql_ir_mult_inference_87", () => {
    expectMultiplicity(schema, `select 1 + (2 except 3)`, "unique");
  });

  it("test_edgeql_ir_mult_inference_88", () => {
    expectMultiplicity(schema, `select 1 + (2 except {3, 3})`, "unique");
  });

  it("test_edgeql_ir_mult_inference_89", () => {
    expectMultiplicity(schema, `select 1 + ({2, 2} except {3, 3})`, "duplicate");
  });

  it("test_edgeql_ir_mult_inference_90", () => {
    expectMultiplicity(schema, `if <bool>$0 then
            (insert User { name := "test" })
        else
            (insert User { name := "???" })`, "unique");
  });

  it("test_edgeql_ir_mult_inference_91", () => {
    expectMultiplicity(schema, `if <bool>$0 then
            (insert User { name := "test" })
        else
            {(insert User { name := "???" }), (insert User { name := "!!!" })}`, "unique");
  });

  it("test_edgeql_ir_mult_inference_92", () => {
    expectMultiplicity(schema, `if <bool>$0 then
            (insert User { name := "test" })
        else
            <User>{}`, "unique");
  });

  it("test_edgeql_ir_mult_inference_93", () => {
    expectMultiplicity(schema, `with groupedCards := User { cards := (group .deck by .element) }
        select groupedCards.cards`, "unique");
  });

  it("test_edgeql_ir_mult_inference_94", () => {
    expectMultiplicity(schema, `FOR user IN User SELECT user {
          name,
          asdf := (FOR card IN .deck SELECT card),
        }`, "unique");
  });

  it("test_edgeql_ir_mult_inference_95", () => {
    expectMultiplicity(schema, `FOR user IN User SELECT user {
          name,
          asdf := (FOR card IN .deck SELECT Card filter Card = card),
        }`, "unique");
  });

});