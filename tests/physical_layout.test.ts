import { describe, expect, it } from "vitest";
import type { SchemaSnapshot } from "../src/schema/schema.js";
import type { TypeDef } from "../src/types.js";
import {
  makeLinkStorageOwnerResolver,
  makeTypeStorageColumnsResolver,
  resolveLinkStorageOwner,
  usesLinkTable,
} from "../src/schema/physical_layout.js";

// Synthetic schema stub: the physical-layout rules only read `schema.getType`,
// so a name→TypeDef map is a sufficient (and isolated) test surface — no SDL.
const schemaOf = (types: Record<string, Partial<TypeDef>>): SchemaSnapshot => {
  const map = new Map<string, TypeDef>();
  for (const [name, def] of Object.entries(types)) {
    const [module, bare] = name.includes("::") ? name.split("::") : ["default", name];
    map.set(name, { module, name: bare, fields: [], ...def } as TypeDef);
  }
  return { getType: (name: string) => map.get(name) } as unknown as SchemaSnapshot;
};

const link = (def: Partial<NonNullable<TypeDef["links"]>[number]>) =>
  ({ name: "owner", multi: false, properties: [], ...def }) as NonNullable<TypeDef["links"]>[number];

describe("usesLinkTable (physical layout re-export)", () => {
  it("inline FK iff single and property-free", () => {
    expect(usesLinkTable(link({ multi: false, properties: [] }))).toBe(false);
    expect(usesLinkTable(link({ multi: true }))).toBe(true);
    expect(usesLinkTable(link({ properties: [{ name: "since" } as never] }))).toBe(true);
  });
});

describe("resolveLinkStorageOwner", () => {
  it("an overloaded link owns its own storage", () => {
    const schema = schemaOf({
      "default::Base": { links: [link({})] },
      "default::Sub": { extends: ["default::Base"], links: [link({ overloaded: true })] },
    });
    const sub = schema.getType("default::Sub")!;
    expect(resolveLinkStorageOwner(schema, sub, sub.links![0]).name).toBe("Sub");
  });

  it("an inherited, equivalent link is owned by the base", () => {
    const schema = schemaOf({
      "default::Base": { links: [link({ targetType: "default::User" })] },
      "default::Sub": { extends: ["default::Base"], links: [link({ targetType: "default::User" })] },
    });
    const sub = schema.getType("default::Sub")!;
    expect(resolveLinkStorageOwner(schema, sub, sub.links![0]).name).toBe("Base");
  });

  // The guard the drifted service.ts mirror lacked: a subtype that re-declares a
  // link incompatibly *without* `overloaded` keeps its own storage — the walk
  // must NOT attribute it to the base (which would point the compile-side JOIN
  // at a table the runtime never writes).
  it("a non-equivalent base re-declaration stops the walk (linkDefsEquivalent guard)", () => {
    const schema = schemaOf({
      "default::Base": { links: [link({ targetType: "default::User", multi: false })] },
      "default::Sub": { extends: ["default::Base"], links: [link({ targetType: "default::User", multi: true })] },
    });
    const sub = schema.getType("default::Sub")!;
    // multi differs → not equivalent → Sub owns it.
    expect(resolveLinkStorageOwner(schema, sub, sub.links![0]).name).toBe("Sub");
  });

  it("stops when the base does not declare the link", () => {
    const schema = schemaOf({
      "default::Base": { links: [] },
      "default::Sub": { extends: ["default::Base"], links: [link({})] },
    });
    const sub = schema.getType("default::Sub")!;
    expect(resolveLinkStorageOwner(schema, sub, sub.links![0]).name).toBe("Sub");
  });
});

describe("makeLinkStorageOwnerResolver (compile-side adapter)", () => {
  it("returns the qualified owner name", () => {
    const schema = schemaOf({
      "default::Base": { links: [link({ targetType: "default::User" })] },
      "default::Sub": { extends: ["default::Base"], links: [link({ targetType: "default::User" })] },
    });
    const resolve = makeLinkStorageOwnerResolver(schema);
    expect(resolve("default::Sub", "owner")).toBe("default::Base");
  });

  it("returns undefined for an unknown type or link", () => {
    const schema = schemaOf({ "default::Sub": { links: [link({})] } });
    const resolve = makeLinkStorageOwnerResolver(schema);
    expect(resolve("default::Missing", "owner")).toBeUndefined();
    expect(resolve("default::Sub", "nope")).toBeUndefined();
  });
});

describe("makeTypeStorageColumnsResolver (compile-side adapter)", () => {
  it("includes id, inline-FK columns, and inherited fields", () => {
    const schema = schemaOf({
      "default::Base": { fields: [{ name: "name" }] as never, links: [link({ name: "owner" })] },
      "default::Sub": {
        extends: ["default::Base"],
        fields: [{ name: "title" }] as never,
        links: [],
      },
    });
    const cols = makeTypeStorageColumnsResolver(schema)("default::Sub");
    expect(cols && [...cols].sort()).toEqual(["id", "name", "owner_id", "title"]);
  });

  it("excludes the FK column when the link uses a junction table", () => {
    const schema = schemaOf({
      "default::T": { fields: [{ name: "name" }] as never, links: [link({ name: "tags", multi: true })] },
    });
    const cols = makeTypeStorageColumnsResolver(schema)("default::T");
    expect(cols && [...cols].sort()).toEqual(["id", "name"]);
    expect(cols?.has("tags_id")).toBe(false);
  });

  it("the most-derived definition decides FK exclusion (subtype overloads to a link table)", () => {
    const schema = schemaOf({
      "default::Base": { links: [link({ name: "owner", multi: false, properties: [] })] },
      "default::Sub": {
        extends: ["default::Base"],
        links: [link({ name: "owner", multi: false, properties: [{ name: "since" } as never], overloaded: true })],
      },
    });
    const cols = makeTypeStorageColumnsResolver(schema)("default::Sub");
    // Sub overloads `owner` into a link table → no owner_id column on Sub.
    expect(cols?.has("owner_id")).toBe(false);
  });

  it("returns undefined for an unknown type", () => {
    const schema = schemaOf({});
    expect(makeTypeStorageColumnsResolver(schema)("default::Missing")).toBeUndefined();
  });
});
