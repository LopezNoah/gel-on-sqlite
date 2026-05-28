import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseEdgeQL } from "../src/edgeql/parser.js";
import { compileToIR } from "../src/compiler/semantic.js";
import { expandSchemaAliasesInStatement } from "../src/compiler/ast_to_ir.js";
import { parseDeclarativeSchema } from "../src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";
import type { SchemaSnapshot } from "../src/schema/schema.js";
import type { Statement } from "../src/edgeql/ast.js";

type Cardinality = "one" | "many" | "at_most_one" | "at_least_one" | "empty" | "unknown";

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

const expectCardinality = (
  schema: SchemaSnapshot,
  source: string,
  expected: Cardinality,
): void => {
  const ir = compileQuery(schema, source);
  const inference = (ir as { inference?: { cardinality?: Cardinality } }).inference;
  expect(inference?.cardinality).toBe(expected);
};

const expectShapeFieldCardinality = (
  schema: SchemaSnapshot,
  source: string,
  field: string,
  expected: Cardinality,
): void => {
  const ir = compileQuery(schema, source);
  const shape = (ir as { shape?: Array<{ name: string; cardinality?: Cardinality; ptrref?: { outCardinality?: Cardinality } }> }).shape ?? [];
  const found = shape.find((el) => el.name === field || el.name?.endsWith?.(field));
  expect(found?.cardinality ?? found?.ptrref?.outCardinality).toBe(expected);
};

// Mirrors test_edgeql_ir_card_inference.py. sqlite-ts has partial cardinality
// inference on SelectIR (id-filter / LIMIT 1) and on pointer refs in GEL IR,
// but the full propagation rules through every expression kind aren't
// implemented yet. Tests are kept as parity placeholders.

describe("TestEdgeQLCardinalityInference", () => {
  let schema: SchemaSnapshot;

  beforeAll(() => {
    schema = loadSchema();
  });

  it("test_edgeql_ir_card_inference_00", () => {
    expectCardinality(schema, `SELECT Card`, "many");
  });

  it("test_edgeql_ir_card_inference_01", () => {
    expectCardinality(schema, `SELECT Card FILTER Card.name = 'Djinn'`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_02", () => {
    expectCardinality(schema, `SELECT Card FILTER 'Djinn' = Card.name`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_03", () => {
    expectCardinality(schema, `SELECT Card FILTER 'foo' = 'foo' AND 'Djinn' = Card.name`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_04", () => {
    expectCardinality(schema, `SELECT Card FILTER 'foo' = 'foo' OR 'Djinn' = Card.name`, "many");
  });

  it("test_edgeql_ir_card_inference_05", () => {
    expectCardinality(schema, `SELECT Card FILTER Card.id = <uuid>'...'`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_06", () => {
    expectCardinality(schema, `WITH C2 := Card
        SELECT Card FILTER Card = (SELECT C2 FILTER C2.name = 'Djinn')`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_07", () => {
    expectCardinality(schema, `WITH C2 := DETACHED Card
        SELECT Card FILTER Card = (SELECT C2 FILTER C2.name = 'Djinn')`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_08", () => {
    expectCardinality(schema, `SELECT Card LIMIT 1`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_09", () => {
    expectCardinality(schema, `SELECT Card FILTER Card.<deck[IS User].name = 'Bob'`, "many");
  });

  it("test_edgeql_ir_card_inference_10", () => {
    expectCardinality(schema, `SELECT 1`, "one");
  });

  it("test_edgeql_ir_card_inference_11", () => {
    expectCardinality(schema, `SELECT {1, 2, 3}`, "at_least_one");
  });

  it("test_edgeql_ir_card_inference_12", () => {
    expectCardinality(schema, `SELECT {1, 2, 3, Card.cost}`, "at_least_one");
  });

  it("test_edgeql_ir_card_inference_13", () => {
    expectCardinality(schema, `SELECT array_agg({1, 2, 3})`, "one");
  });

  it("test_edgeql_ir_card_inference_14", () => {
    expectCardinality(schema, `SELECT array_agg(Card.cost)`, "one");
  });

  it("test_edgeql_ir_card_inference_15", () => {
    expectCardinality(schema, `SELECT to_str(Card.cost)`, "many");
  });

  it("test_edgeql_ir_card_inference_16", () => {
    expectCardinality(schema, `SELECT to_str((SELECT Card.cost LIMIT 1))`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_17", () => {
    expectCardinality(schema, `SELECT to_str({1, (SELECT Card.cost LIMIT 1)})`, "at_least_one");
  });

  it("test_edgeql_ir_card_inference_18", () => {
    expectCardinality(schema, `SELECT to_str(1)`, "one");
  });

  it("test_edgeql_ir_card_inference_19", () => {
    expectCardinality(schema, `SELECT 1 + 2`, "one");
  });

  it("test_edgeql_ir_card_inference_20", () => {
    expectCardinality(schema, `SELECT 1 + (2 UNION 3)`, "at_least_one");
  });

  it("test_edgeql_ir_card_inference_21", () => {
    expectCardinality(schema, `SELECT 1 + Card.cost`, "many");
  });

  it("test_edgeql_ir_card_inference_22", () => {
    expectCardinality(schema, `SELECT (SELECT Card LIMIT 1).cost ?? 99`, "one");
  });

  it("test_edgeql_ir_card_inference_23", () => {
    expectCardinality(schema, `SELECT (SELECT Card LIMIT 1).element ?? (SELECT User LIMIT 1).name`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_24 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT (SELECT Card LIMIT 1).element ?= 'fire'`, "one");
  });

  it("test_edgeql_ir_card_inference_25 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT Named {
            name
        }`, "name", "one");
  });

  it("test_edgeql_ir_card_inference_26 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT User {
            foo := .name
        }`, "foo", "one");
  });

  it("test_edgeql_ir_card_inference_27 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT User {
            foo := 'prefix_' ++ .name
        }`, "foo", "one");
  });

  it("test_edgeql_ir_card_inference_28 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT User {
            deck_cost
        }`, "deck_cost", "one");
  });

  it("test_edgeql_ir_card_inference_29 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT User {
            dc := sum(.deck.cost)
        }`, "dc", "one");
  });

  it("test_edgeql_ir_card_inference_30 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT User {
            deck
        }`, "deck", "many");
  });

  it("test_edgeql_ir_card_inference_31 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT Card {
            owners
        }`, "owners", "many");
  });

  it("test_edgeql_ir_card_inference_32 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `WITH
            A := (SELECT Award LIMIT 1)
        # the "awards" are exclusive
        SELECT A.<awards[IS User]`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_33 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT Award {
            # the "awards" are exclusive
            recipient := .<awards[IS User]
        }`, "recipient", "at_most_one");
  });

  it("test_edgeql_ir_card_inference_34 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT Award {
            rec
        }`, "rec", "at_most_one");
  });

  it("test_edgeql_ir_card_inference_35 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT AwardAlias {
            recipient
        }`, "recipient", "at_most_one");
  });

  it("test_edgeql_ir_card_inference_36 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT Eert {
            parent
        }`, "parent", "at_most_one");
  });

  it("test_edgeql_ir_card_inference_36b [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT Eert {
            asdf := .<children[is Eert]
        }`, "asdf", "at_most_one");
  });

  it("test_edgeql_ir_card_inference_36c [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT Eert {
            asdf := .<children[is Asdf]
        }`, "asdf", "many");
  });

  it("test_edgeql_ir_card_inference_36d [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT Eert {
            asdf := .<children[is Object]
        }`, "asdf", "many");
  });

  it("test_edgeql_ir_card_inference_37 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT Report {
            user_name := .user.name
        }`, "user_name", "one");
  });

  it("test_edgeql_ir_card_inference_38 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT Report {
            name := .user.name
        }`, "name", "one");
  });

  it("test_edgeql_ir_card_inference_39 [unconverted: must_fail cardinality diagnostic not implemented]", () => {
    expect(() => compileQuery(schema, `SELECT Report {
    name := <str>{}
}`)).toThrow();
  });

  it("test_edgeql_ir_card_inference_40 [unconverted: must_fail cardinality diagnostic not implemented]", () => {
    expect(() => compileQuery(schema, `SELECT Report {
    single foo := User.name
}`)).toThrow();
  });

  it("test_edgeql_ir_card_inference_41 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT User.deck@count`, "many");
  });

  it("test_edgeql_ir_card_inference_42 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT Report.user@note`, "many");
  });

  it("test_edgeql_ir_card_inference_43 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT User {
            foo := .deck@count
        }`, "foo", "many");
  });

  it("test_edgeql_ir_card_inference_44 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT Report {
            foo := .user@note
        }`, "foo", "at_most_one");
  });

  it("test_edgeql_ir_card_inference_45 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT Report {
            subtitle := 'aaa'
        }`, "subtitle", "one");
  });

  it("test_edgeql_ir_card_inference_46 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT Named {
            as_card := Named[IS Card]
        }`, "as_card", "at_most_one");
  });

  it("test_edgeql_ir_card_inference_47 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT User {
            foo := EXISTS(.friends)
        }`, "foo", "one");
  });

  it("test_edgeql_ir_card_inference_48 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT Card {
            o_name := .owners.name,
        }`, "o_name", "many");
  });

  it("test_edgeql_ir_card_inference_49 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT User {
            name,
            fire_deck := (
                SELECT User.deck {name, element}
                FILTER .element = 'Fire'
                ORDER BY .name
            ).name
        }`, "fire_deck", "many");
  });

  it("test_edgeql_ir_card_inference_50 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `INSERT User {name := "Timmy"}
        UNLESS CONFLICT`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_51 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `INSERT User {name := "Johnny"}
        UNLESS CONFLICT ON (.name)
        ELSE User`, "one");
  });

  it("test_edgeql_ir_card_inference_52 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `INSERT User {name := "Spike"}
        UNLESS CONFLICT ON (.name)
        ELSE Card`, "many");
  });

  it("test_edgeql_ir_card_inference_53 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `INSERT User {name := "Madz"}
        UNLESS CONFLICT ON (.name)
        ELSE (DETACHED (INSERT User {name := "Madz2"}))`, "one");
  });

  it("test_edgeql_ir_card_inference_54 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT Person FILTER .first = "Phil" AND .last = "Emarg"`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_55 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT Person FILTER .first = "Phil"`, "many");
  });

  it("test_edgeql_ir_card_inference_56 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT Person FILTER .email = "test@example.com"`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_57 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT Person { first } FILTER .p = 7 AND .q = 3`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_58 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT Person FILTER .last = "Hatch" AND .first = "Madeline"`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_59 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT Person FILTER .p = 7 AND .q = 3 AND .first = "???"`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_60 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT Person
        FILTER .p = 12 AND .card = (SELECT Card FILTER .name = 'Imp')`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_60b [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT Person
        FILTER .p = 12 AND .card.name = 'Imp'`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_61 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT Person FILTER .first = "Phil" OR .last = "Emarg"`, "many");
  });

  it("test_edgeql_ir_card_inference_62 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT Person FILTER .p = 7 AND .q = 3 AND .last = "Whatever"`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_63 [unconverted: must_fail cardinality diagnostic not implemented]", () => {
    expect(() => compileQuery(schema, `WITH X := User { busted := (SELECT 1 ORDER BY {1,2}) },
SELECT X`)).toThrow();
  });

  it("test_edgeql_ir_card_inference_64 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT (FOR x IN {1,2} UNION (SELECT User { m := x })) { m }`, "m", "one");
  });

  it("test_edgeql_ir_card_inference_65 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT (SELECT User { multi m := 1 }) { m }`, "m", "at_least_one");
  });

  it("test_edgeql_ir_card_inference_66 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `WITH Z := (SELECT (SELECT User) ORDER BY .name), SELECT Z`, "many");
  });

  it("test_edgeql_ir_card_inference_67 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT { o := (SELECT (SELECT User) ORDER BY .name) }`, "one");
  });

  it("test_edgeql_ir_card_inference_68 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT 1 FILTER false`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_69 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT {1, 2} FILTER false`, "many");
  });

  it("test_edgeql_ir_card_inference_70 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT (1, 'a')`, "one");
  });

  it("test_edgeql_ir_card_inference_71 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT (1, Card.name)`, "many");
  });

  it("test_edgeql_ir_card_inference_71b [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT ((1, Card {name}),).0`, "many");
  });

  it("test_edgeql_ir_card_inference_72 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT {a := 42}`, "one");
  });

  it("test_edgeql_ir_card_inference_73 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `FOR x IN {0, 1} UNION {a := x}`, "at_least_one");
  });

  it("test_edgeql_ir_card_inference_74 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT taking_opt_returning_non_opt("foo")`, "one");
  });

  it("test_edgeql_ir_card_inference_75 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT taking_opt_returning_non_opt(<str>{})`, "one");
  });

  it("test_edgeql_ir_card_inference_76 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT taking_non_opt_returning_opt("foo")`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_77 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT taking_non_opt_returning_opt(<str>{})`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_78 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT len("foo")`, "one");
  });

  it("test_edgeql_ir_card_inference_79 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT len(<str>{})`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_80 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `WITH s := {1, 2, 3}
        SELECT max(s)`, "one");
  });

  it("test_edgeql_ir_card_inference_81 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT max(Person.p)`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_82 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT assert_single(Person.p)`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_83 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT Card {
            element := assert_single(.element ++ "1")
        }`, "element", "one");
  });

  it("test_edgeql_ir_card_inference_84 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT array_get([1, 2, 3], {0, 2})`, "many");
  });

  it("test_edgeql_ir_card_inference_85 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT User { optional multi m := 1 }`, "m", "many");
  });

  it("test_edgeql_ir_card_inference_86 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT User { required multi m := 1 }`, "m", "at_least_one");
  });

  it("test_edgeql_ir_card_inference_87 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT User { optional m := 1 }`, "m", "at_most_one");
  });

  it("test_edgeql_ir_card_inference_88 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT User { m := assert_distinct(1) }`, "m", "one");
  });

  it("test_edgeql_ir_card_inference_89 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT User { m := assert_distinct(Card) }`, "m", "many");
  });

  it("test_edgeql_ir_card_inference_90 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT User { m := assert_distinct(assert_exists(Card)) }`, "m", "at_least_one");
  });

  it("test_edgeql_ir_card_inference_91 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT User {
            m := assert_distinct(assert_exists(assert_single(Card)))
        }`, "m", "one");
  });

  it("test_edgeql_ir_card_inference_92 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `WITH
            inserted := (INSERT Award { name := <str>$0 }),
            all := (inserted UNION (SELECT Award)),
        SELECT DISTINCT (all { name })
        ORDER BY .name ASC`, "name", "one");
  });

  it("test_edgeql_ir_card_inference_93 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT (User { friends: { required bs := .name } },
                User.friends.name ?? 'a')`, "many");
  });

  it("test_edgeql_ir_card_inference_94 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `SELECT User { foo := enumerate(.name) }`, "foo", "one");
  });

  it("test_edgeql_ir_card_inference_95 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `WITH x := User
        SELECT (
            WITH y := x
            SELECT (y,).0
        )`, "many");
  });

  it("test_edgeql_ir_card_inference_96 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT (
            (SELECT User),
            (User,).0,
        )`, "many");
  });

  it("test_edgeql_ir_card_inference_97 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT (
            (User,).0,
            (User,).0,
        )`, "many");
  });

  it("test_edgeql_ir_card_inference_98 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT (Card.name ?? "N/A", Card.element ?? "N/A")`, "at_least_one");
  });

  it("test_edgeql_ir_card_inference_99 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT {1, 2} LIMIT 1`, "one");
  });

  it("test_edgeql_ir_card_inference_100 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT assert_exists(User) LIMIT 1`, "one");
  });

  it("test_edgeql_ir_card_inference_101 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT 1 LIMIT 0`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_102 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT 1 LIMIT (SELECT count(User))`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_103 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT {1, 2} LIMIT (SELECT count(User))`, "many");
  });

  it("test_edgeql_ir_card_inference_104 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `SELECT 1 OFFSET 2`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_105 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select User
        filter .avatar.name = 'Dragon'`, "many");
  });

  it("test_edgeql_ir_card_inference_106 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select User
        filter .unique_avatar.name = 'Dragon'`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_107 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `WITH
          __scope_0_Hero := DETACHED default::User
        UPDATE __scope_0_Hero
        FILTER (__scope_0_Hero.name = "Spider-Man")
        SET {
          name := ("The Amazing " ++ __scope_0_Hero.name)
        }`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_108 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `WITH
          __scope_0_Hero := DETACHED default::User
        SELECT __scope_0_Hero
        FILTER (__scope_0_Hero.name = "Spider-Man")`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_109 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select User
        filter (detached (select User limit 1)).name = 'Alice'`, "many");
  });

  it("test_edgeql_ir_card_inference_110 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `with z := (select User { asdf := .name })
        select (
            even := z.asdf,
            elements := count(z)
        )`, "many");
  });

  it("test_edgeql_ir_card_inference_111 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `with z := (select User { asdf := {.name} })
        select (
            even := z.asdf,
            elements := count(z)
        )`, "many");
  });

  it("test_edgeql_ir_card_inference_112 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select <str>to_json('null')`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_113 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select <array<str>>[]`, "one");
  });

  it("test_edgeql_ir_card_inference_114 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select 1 + (2 intersect 3)`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_115 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select 1 + (2 intersect {3, 4})`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_116 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select 1 + ({2, 3} intersect {3, 4})`, "many");
  });

  it("test_edgeql_ir_card_inference_117 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select 1 + ({2, 3} intersect <int64>{})`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_118 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select 1 + (2 except 3)`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_119 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select 1 + (2 except {3, 4})`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_120 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select 1 + ({2, 3} except {3, 4})`, "many");
  });

  it("test_edgeql_ir_card_inference_121 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `with X := {User, User},
        select X filter .name = 'Alice'`, "many");
  });

  it("test_edgeql_ir_card_inference_122 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `with X := {User, User},
        update X filter .name = 'Alice' set { }`, "many");
  });

  it("test_edgeql_ir_card_inference_123 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `select Card { req_awards }`, "req_awards", "at_least_one");
  });

  it("test_edgeql_ir_card_inference_124 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `select Card { x := .req_awards }`, "x", "at_least_one");
  });

  it("test_edgeql_ir_card_inference_125 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `select Card { required x := .req_awards }`, "x", "at_least_one");
  });

  it("test_edgeql_ir_card_inference_126 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `select Card { req_tags }`, "req_tags", "at_least_one");
  });

  it("test_edgeql_ir_card_inference_127 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `select Card { x := .req_tags }`, "x", "at_least_one");
  });

  it("test_edgeql_ir_card_inference_128 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `select Card { required x := .req_tags }`, "x", "at_least_one");
  });

  it("test_edgeql_ir_card_inference_129 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select assert(<bool>{})`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_130 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select assert(<bool>{}, message := {'uh', 'oh'})`, "many");
  });

  it("test_edgeql_ir_card_inference_131 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select assert(true, message := {'uh', 'oh'})`, "at_least_one");
  });

  it("test_edgeql_ir_card_inference_132 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select distinct <str>{}`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_133 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select distinct 1`, "one");
  });

  it("test_edgeql_ir_card_inference_134 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select distinct {1, 2}`, "at_least_one");
  });

  it("test_edgeql_ir_card_inference_135 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `<str>{} if true else {'foo', 'bar'}`, "many");
  });

  it("test_edgeql_ir_card_inference_136 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `<str>{} if true else 'foo'`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_137 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `'bar' if true else 'foo'`, "one");
  });

  it("test_edgeql_ir_card_inference_138 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `assert_exists(1, message := {"uh", "oh"})`, "at_least_one");
  });

  it("test_edgeql_ir_card_inference_139 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `if <bool>$0 then
            (insert User { name := "test" })
        else
            (insert User { name := "???" })`, "one");
  });

  it("test_edgeql_ir_card_inference_140 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `if <bool>$0 then
            (insert User { name := "test" })
        else
            {(insert User { name := "???" }), (insert User { name := "!!!" })}`, "at_least_one");
  });

  it("test_edgeql_ir_card_inference_141 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `if <bool>$0 then
            (insert User { name := "test" })
        else
            <User>{}`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_142 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `select Named { [is Card].element }`, "element", "at_most_one");
  });

  it("test_edgeql_ir_card_inference_143 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `select Named { element := [is Card].element }`, "element", "at_most_one");
  });

  it("test_edgeql_ir_card_inference_144 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select (
          select assert_exists(Named) { [is Card].element } limit 1).element`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_145 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `select Named { [is Named].name }`, "name", "one");
  });

  it("test_edgeql_ir_card_inference_146 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `select User { [is Named].name }`, "name", "one");
  });

  it("test_edgeql_ir_card_inference_147 [unconverted: must_fail cardinality diagnostic not implemented]", () => {
    expect(() => compileQuery(schema, `select Named { [is User].name }`)).toThrow();
  });

  it("test_edgeql_ir_card_inference_148 [unconverted: must_fail cardinality diagnostic not implemented]", () => {
    expect(() => compileQuery(schema, `select Named { name := [is User].name }`)).toThrow();
  });

  it("test_edgeql_ir_card_inference_149 [unconverted: must_fail cardinality diagnostic not implemented]", () => {
    expect(() => compileQuery(schema, `select Named { [is schema::Object].name }`)).toThrow();
  });

  it("test_edgeql_ir_card_inference_150 [unconverted: must_fail cardinality diagnostic not implemented]", () => {
    expect(() => compileQuery(schema, `select User { [is schema::Object].name }`)).toThrow();
  });

  it("test_edgeql_ir_card_inference_151 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `select Tgt { back := .<lnk[is Src] }`, "back", "many");
  });

  it("test_edgeql_ir_card_inference_152 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `select Tgt { back := .<lnk[is SrcSub1] }`, "back", "at_most_one");
  });

  it("test_edgeql_ir_card_inference_153 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select Named filter .name = ''`, "many");
  });

  it("test_edgeql_ir_card_inference_154 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select Named2 filter .name = ''`, "many");
  });

  it("test_edgeql_ir_card_inference_155 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select Named2Sub filter .name = ''`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_156 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select global Alice`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_157 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `select global GameAdmin`, "one");
  });

  it("test_edgeql_ir_card_inference_158 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `with TypeExpr := Object[is TypeExprA | TypeExprB]
        select assert_exists(assert_single(TypeExpr)).val`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_159 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `with TypeExpr := Object[is TypeExprA | TypeExprC]
        select assert_exists(assert_single(TypeExpr)).val`, "many");
  });

  it("test_edgeql_ir_card_inference_160 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `with TypeExpr := Object[is TypeExprA | TypeExprD]
        select assert_exists(assert_single(TypeExpr)).val`, "many");
  });

  it("test_edgeql_ir_card_inference_161 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `with TypeExpr := Object[is TypeExprB | TypeExprC]
        select assert_exists(assert_single(TypeExpr)).val`, "many");
  });

  it("test_edgeql_ir_card_inference_162 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `with TypeExpr := Object[is TypeExprB | TypeExprD]
        select assert_exists(assert_single(TypeExpr)).val`, "at_least_one");
  });

  it("test_edgeql_ir_card_inference_163 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `with TypeExpr := Object[is TypeExprC | TypeExprD]
        select assert_exists(assert_single(TypeExpr)).val`, "many");
  });

  it("test_edgeql_ir_card_inference_164 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `with TypeExpr := Object[is TypeExprA & TypeExprB]
        select assert_exists(assert_single(TypeExpr)).val`, "one");
  });

  it("test_edgeql_ir_card_inference_165 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `with TypeExpr := Object[is TypeExprA & TypeExprC]
        select assert_exists(assert_single(TypeExpr)).val`, "at_most_one");
  });

  it("test_edgeql_ir_card_inference_166 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `with TypeExpr := Object[is TypeExprA & TypeExprD]
        select assert_exists(assert_single(TypeExpr)).val`, "one");
  });

  it("test_edgeql_ir_card_inference_167 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `with TypeExpr := Object[is TypeExprB & TypeExprC]
        select assert_exists(assert_single(TypeExpr)).val`, "one");
  });

  it("test_edgeql_ir_card_inference_168 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `with TypeExpr := Object[is TypeExprB & TypeExprD]
        select assert_exists(assert_single(TypeExpr)).val`, "one");
  });

  it("test_edgeql_ir_card_inference_169 [unconverted: full cardinality inference not implemented]", () => {
    expectCardinality(schema, `with TypeExpr := Object[is TypeExprC & TypeExprD]
        select assert_exists(assert_single(TypeExpr)).val`, "at_least_one");
  });

  it("test_edgeql_ir_card_inference_170 [unconverted: shape-element cardinality inference not implemented]", () => {
    expectShapeFieldCardinality(schema, `select Report { u := .?>user }`, "u", "at_most_one");
  });

});