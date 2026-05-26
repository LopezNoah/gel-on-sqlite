import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseEdgeQL } from "../src/edgeql/parser.js";
import { compileToIR } from "../src/compiler/semantic.js";
import { expandSchemaAliasesInStatement } from "../src/compiler/ast_to_ir.js";
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
  return compileToIR(schema, expandSchemaAliasesInStatement(stmt, schema));
};

const expectMultiplicity = (
  schema: SchemaSnapshot,
  source: string,
  expected: Multiplicity,
): void => {
  const ir = compileQuery(schema, source);
  const inference = (ir as { inference?: { multiplicity?: Multiplicity } }).inference;
  expect(inference?.multiplicity).toBe(expected);
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

  it.skip("test_edgeql_ir_mult_inference_00 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT Card`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_01 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT Card.id`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_02 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT User.name`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_03 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT User.deck_cost`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_04 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT Card FILTER Card.name = 'Djinn'`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_05 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT Card LIMIT 1`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_06 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT 1`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_07 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT {1, 2}`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_08 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT {1, 1}`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_09 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT User.deck`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_10 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT Card.cost`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_11 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT Card.owners`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_12 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT {Card, User}`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_13 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT 1 + 2`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_14a [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT 1 + {2, 3}`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_14b [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT 0 * {2, 3}`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_15 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT {1, 2} + {2, 3}`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_16 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT 'pre_' ++ Card.name`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_17 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT User.name ++ Card.name`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_18 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT (1, {'a', 'b'})`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_19 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT (1, Card.name)`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_20 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT [1, {1, 2}]`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_21 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT ['card', Card.name]`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_22 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT User.name ++ Card.name`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_23 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT to_str(1)`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_24 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `WITH
            C := (SELECT Card FILTER .name = 'Imp')
        SELECT str_split(<str>C.id, '')`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_25 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT str_split(<str>Card.id, '')`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_26 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT array_unpack(str_split(<str>Card.id, ''))`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_27 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT count(Card)`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_28 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT 1 IN {1, 2, 3}`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_29 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT 1 IN {1, 1, 3}`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_30 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT {1, 2} IN {1, 2, 3}`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_31 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT Card.name IN {'Imp', 'Dragon'}`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_32 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT <str>{1, 2, 3}`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_33 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT <str>{1, 1, 3}`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_34 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT <str>Card.id`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_35 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT <json>User.name`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_36 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT <str>Card.cost`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_37 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT User.deck[IS SpecialCard]`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_38 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT Award.<awards[IS User]`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_39 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT (1, Card.name).0`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_40 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT (1, Card.name).1`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_41 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT ['card', Card.name][0]`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_42 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT ['card', Card.name][1]`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_43 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT DISTINCT Card.element`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_44 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT User {
            friends_of_friends := .friends.friends,
            others := (
                SELECT WaterOrEarthCard.owners
            )
        }`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_45 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT Award {
            owner := .<awards[IS User]
        }`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_46 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT User {
            card_names := .deck.name,
            card_elements := DISTINCT .deck.element,
            deck: {
                el := User.deck.element[:2]
            }
        }`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_47 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT 1 IS str`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_48 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT Award IS Named`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_49 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `WITH
            A := (
                SELECT Award FILTER .name = 'Wow'
            )
        SELECT A IS Named`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_50 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT Award.name IS str`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_51 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT INTROSPECT TYPEOF User.deck`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_52 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT (INTROSPECT TYPEOF User.deck).name`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_53 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT User {
            card_elements := .deck.element
        }`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_54 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT User {
            foo := {1, 1, 2}
        }`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_55a [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `FOR x IN {'fire', 'water'}
        UNION (
            SELECT Card
            FILTER .element = x
        )`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_55b [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `FOR letter IN {'I', 'B'}
        UNION (
            SELECT Card
            FILTER .name[0] = letter
        )`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_56 [unconverted: full multiplicity inference not implemented]", () => {
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

  it.skip("test_edgeql_ir_mult_inference_57 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT enumerate({2, 2})`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_58 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT enumerate(Card)`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_59 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `FOR x IN {enumerate({'fire', 'water'})}
        UNION (
            SELECT Card
            FILTER .element = x.1
        )`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_59a [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `FOR x IN {enumerate({'fire', 'water'})}
        UNION (
            SELECT (
                SELECT Card
                FILTER .element = x.1
            )
        )`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_60 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `FOR x IN {
            enumerate(
                DISTINCT array_unpack(['fire', 'water']))
        }
        UNION (
            SELECT Card
            FILTER .element = x.1
        )`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_61 [unconverted: full multiplicity inference not implemented]", () => {
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

  it.skip("test_edgeql_ir_mult_inference_62 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT Card UNION SpecialCard`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_63 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `FOR card IN {enumerate(Card)}
        UNION (SELECT card.1)`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_64 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `FOR card IN {Card}
        UNION card`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_65 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `WITH C := <Card>{}
        FOR card IN {C}
        UNION card`, "empty");
  });

  it.skip("test_edgeql_ir_mult_inference_66 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `FOR card IN {Card, SpecialCard}
        UNION card`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_67 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT
            (SELECT User FILTER .name = "foo")
            ??
            (SELECT User FILTER .name = "bar")`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_68 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT
            (SELECT User FILTER .name = "foo")
            ??
            {
                User,
                User,
            }`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_69 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT
            {
                (INSERT User { name := "a" }),
                (INSERT User { name := "b" }),
            }`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_70 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `WITH
            X1 := Card {
                z := (.<deck[IS User],)
            }
        SELECT X1 {
            foo := .z.0
        }.foo`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_71 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `FOR card IN {assert_distinct(Card UNION SpecialCard)}
        UNION card`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_error_01 [unconverted: must_fail multiplicity diagnostic not implemented]", () => {
    expect(() => compileQuery(schema, `SELECT User {
    bad_link := {Card, Card},
    name,
}`)).toThrow();
  });

  it.skip("test_edgeql_ir_mult_inference_error_02 [unconverted: must_fail multiplicity diagnostic not implemented]", () => {
    expect(() => compileQuery(schema, `WITH
    A := {Card, Card}
SELECT User {
    bad_link := A,
    name,
}`)).toThrow();
  });

  it.skip("test_edgeql_ir_mult_inference_72 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT ()`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_73 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT {(), ()}`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_74 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT <array<str>>[]`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_75 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT <str>{}`, "empty");
  });

  it.skip("test_edgeql_ir_mult_inference_76 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `SELECT (Card, User).1`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_77 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `for x in {1, 2} union { foo := 10 }`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_77b [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `for x in {1, 1} union { foo := 10 }`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_78 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `with F := { foo := 10 }
        for x in {1, 2} union F`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_79 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `for x in {1, 2, 3} union (with z := x, select z)`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_80 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `for x in {1,2} union (for y in {3, 4} union x)`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_81 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `for x in {1,2} union (for y in {3, 4} union y)`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_82 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `select 1 union 1`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_83 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `select 1 + (2 intersect 3)`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_84 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `select 1 + (2 intersect {3, 3})`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_85 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `select 1 + ({2, 2} intersect {3, 3})`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_86 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `select {2, 2} intersect <int64>{}`, "empty");
  });

  it.skip("test_edgeql_ir_mult_inference_87 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `select 1 + (2 except 3)`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_88 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `select 1 + (2 except {3, 3})`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_89 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `select 1 + ({2, 2} except {3, 3})`, "duplicate");
  });

  it.skip("test_edgeql_ir_mult_inference_90 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `if <bool>$0 then
            (insert User { name := "test" })
        else
            (insert User { name := "???" })`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_91 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `if <bool>$0 then
            (insert User { name := "test" })
        else
            {(insert User { name := "???" }), (insert User { name := "!!!" })}`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_92 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `if <bool>$0 then
            (insert User { name := "test" })
        else
            <User>{}`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_93 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `with groupedCards := User { cards := (group .deck by .element) }
        select groupedCards.cards`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_94 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `FOR user IN User SELECT user {
          name,
          asdf := (FOR card IN .deck SELECT card),
        }`, "unique");
  });

  it.skip("test_edgeql_ir_mult_inference_95 [unconverted: full multiplicity inference not implemented]", () => {
    expectMultiplicity(schema, `FOR user IN User SELECT user {
          name,
          asdf := (FOR card IN .deck SELECT Card filter Card = card),
        }`, "unique");
  });

});