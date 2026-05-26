import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { PathId, replacePathIdPrefix, type PointerDirection } from "../src/ir/pathid.js";
import type { SchemaSnapshot } from "../src/schema/schema.js";
import { parseDeclarativeSchema } from "../src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";

type PathStep = string
  | [stepName: string, namespace: Iterable<string>]
  | [stepName: string, namespace: Iterable<string>, direction: PointerDirection];

const namespace = (...items: string[]): Set<string> => new Set(items);

const loadCardsSchema = (): SchemaSnapshot => {
  const source = fs.readFileSync(new URL("./schemas/cards.esdl", import.meta.url), "utf8");
  const decl = parseDeclarativeSchema(`module default {\n${source}\n}`, {
    legacySyntaxCompat: true,
  });
  return schemaSnapshotFromDeclarative(decl);
};

describe("TestEdgeQLIRPathID", () => {
  let schema: SchemaSnapshot;

  beforeAll(() => {
    schema = loadCardsSchema();
  });

  const extend = (
    pathId: PathId,
    stepName: string,
    ns: Iterable<string> = [],
    direction: PointerDirection = "outbound",
  ): PathId => pathId.extend(schema, stepName, { namespace: ns, direction });

  const extendMany = (pathId: PathId, ...path: PathStep[]): PathId => {
    let current = pathId;
    for (const pathStep of path) {
      if (typeof pathStep === "string") {
        current = extend(current, pathStep);
        continue;
      }

      const [stepName, ns, direction = "outbound"] = pathStep;
      current = extend(current, stepName, ns, direction);
    }
    return current;
  };

  const mkPath = (
    start: string,
    ...path: PathStep[]
  ): PathId => extendMany(PathId.fromType(schema, start), ...path);

  const mkPathInNamespace = (
    start: string,
    ns: Iterable<string>,
    ...path: PathStep[]
  ): PathId => extendMany(PathId.fromType(schema, start, { namespace: ns }), ...path);

  const expectPath = (actual: PathId | undefined, expected: PathId): void => {
    expect(actual?.equals(expected)).toBe(true);
  };

  it("test_edgeql_ir_pathid_basic", () => {
    const pid1 = mkPath("User");
    expect(pid1.toString()).toBe("(default::User)");

    expect(pid1.isObjectTypePath()).toBe(true);
    expect(pid1.isScalarPath()).toBe(false);

    expect(pid1.rptr()).toBeUndefined();
    expect(pid1.rptrDirection()).toBeUndefined();
    expect(pid1.rptrName()).toBeUndefined();
    expect(pid1.srcPath()).toBeUndefined();

    const pid2 = extend(pid1, "deck");
    expect(pid2.toString()).toBe("(default::User).>deck[IS default::Card]");

    expect(pid2.rptr()?.shortName).toBe("deck");
    expect(pid2.rptrDirection()).toBe("outbound");
    expect(pid2.rptrName()).toBe("deck");
    expectPath(pid2.srcPath(), pid1);

    const ptrPid = pid2.ptrPath();
    expect(ptrPid.toString()).toBe("(default::User).>deck[IS default::Card]@");

    expect(ptrPid.isPointerPath()).toBe(true);
    expect(ptrPid.isObjectTypePath()).toBe(false);
    expect(ptrPid.isScalarPath()).toBe(false);

    expectPath(ptrPid.tgtPath(), pid2);

    const propPid = extend(pid2, "@count");
    expect(propPid.toString()).toBe("(default::User).>deck[IS default::Card]@count[IS std::int64]");

    expect(propPid.isPointerPath()).toBe(false);
    expect(propPid.isObjectTypePath()).toBe(false);
    expect(propPid.isScalarPath()).toBe(true);
    expect(propPid.isLinkPropertyPath()).toBe(true);
    expectPath(propPid.srcPath(), ptrPid);
  });

  it("test_edgeql_ir_pathid_startswith", () => {
    const pid1 = mkPath("User");
    const pid2 = extend(pid1, "deck");
    const ptrPid = pid2.ptrPath();
    const propPid = extend(pid2, "@count");

    expect(pid2.startsWith(pid1)).toBe(true);
    expect(pid1.startsWith(pid2)).toBe(false);

    expect(ptrPid.startsWith(pid1)).toBe(true);
    expect(propPid.startsWith(pid1)).toBe(true);

    expect(ptrPid.startsWith(pid2)).toBe(false);
    expect(propPid.startsWith(pid2)).toBe(false);

    expect(propPid.startsWith(ptrPid)).toBe(true);
  });

  it("test_edgeql_ir_pathid_namespace_01", () => {
    const ns = namespace("foo");
    const pid1 = mkPathInNamespace("User", ns);
    const pid2 = extend(pid1, "deck");
    const ptrPid = pid2.ptrPath();
    const propPid = extend(pid2, "@count");

    expect(pid1.namespace).toEqual(ns);
    expect(pid2.namespace).toEqual(ns);
    expect(ptrPid.namespace).toEqual(ns);
    expect(propPid.namespace).toEqual(ns);

    const pid1NoNs = mkPath("User");
    expect(pid1.equals(pid1NoNs)).toBe(false);
  });

  it("test_edgeql_ir_pathid_namespace_02", () => {
    const ns1 = namespace("foo");
    const ns2 = namespace("bar");

    const pid1 = mkPath("Card");
    const pid2 = extend(pid1, "owners", ns1);
    const pid2NoNs = extend(pid1, "owners");

    expect(pid2.equals(pid2NoNs)).toBe(false);
    expectPath(pid2.srcPath(), pid1);

    const pid3 = extend(pid2, "deck", ns2);
    const propPid = extend(pid3, "@count");

    expect(propPid.srcPath()?.namespace).toEqual(namespace("foo", "bar"));
    expect(propPid.srcPath()?.srcPath()?.namespace).toEqual(ns1);
    expect(propPid.srcPath()?.srcPath()?.srcPath()?.namespace).toEqual(namespace());

    const prefixes = [...pid3.iterPrefixes()].map(String);

    expect(prefixes).toEqual([
      "(default::Card)",
      "foo@@(default::Card).>owners[IS default::User]",
      "bar@foo@@(default::Card).>owners[IS default::User].>deck[IS default::Card]",
    ]);
  });

  it("test_edgeql_ir_pathid_replace_01", () => {
    const base1 = mkPath("Card");
    const base2 = mkPath("SpecialCard");

    const ns = namespace("ns");
    const ptr1 = extend(base1, "name", ns);
    const ptr2 = extend(base2, "name", ns);

    const ptr1b = replacePathIdPrefix(ptr1, base1, base2);

    expect(ptr1b.toString()).toBe(ptr2.toString());
  });

  it("test_edgeql_ir_pathid_replace_02", () => {
    const base1 = mkPathInNamespace("Card", namespace("ns1"));
    const base2 = mkPathInNamespace("SpecialCard", namespace("ns2"));

    const ptr1 = extend(base1, "name");
    const ptr2 = extend(base2, "name");

    const ptr1b = replacePathIdPrefix(ptr1, base1, base2);

    expect(ptr1b.toString()).toBe(ptr2.toString());
  });

  it("test_edgeql_ir_pathid_replace_03a", () => {
    const base1 = mkPath("User", "deck");
    const base2 = mkPath("Bot", "deck");

    const ptr1 = extend(base1, "@count");
    const ptr2 = extend(base2, "@count");

    const ptr1b = replacePathIdPrefix(ptr1, base1, base2, {
      permissivePointerPath: true,
    });
    expect(ptr1b.toString()).toBe(ptr2.toString());

    const ptr1c = replacePathIdPrefix(ptr1, base1.ptrPath(), base2.ptrPath());
    expect(ptr1c.toString()).toBe(ptr2.toString());
  });

  it("test_edgeql_ir_pathid_replace_03b", () => {
    const base1 = mkPath("User", "deck");
    const base2 = mkPath("Bot", "deck");

    const ptr1 = extend(base1, "@count");
    const ptr2 = extend(base2, "@count");

    const ptr1b = replacePathIdPrefix(ptr1, base1, base2, {
      permissivePointerPath: true,
    });

    expect(ptr1b.toString()).toBe(ptr2.toString());
  });
});
