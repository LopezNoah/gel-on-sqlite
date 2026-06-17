import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDeclarativeSchema } from "../src/schema/sdl_adapter.js";
import { AnnotationRegistry } from "../src/schema/annos.js";
import { TypeMemberResolver } from "../src/schema/type_member_resolver.js";
import type { TypeMember } from "../src/schema/declarative.js";

// Drive the resolver off the real `issues` schema — it exercises multi-base
// inheritance (`Issue extending Named, Owned, Text`), an overloaded property
// with an added constraint (`Dictionary` overloads `Named.name`), and an
// overloaded link that adds a link property (`Issue` overloads `Owned.owner`
// adding `since` while the base carries `note`).
const schemaDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "schemas");
const issuesSrc = fs.readFileSync(path.join(schemaDir, "issues.esdl"), "utf8");
const schema = parseDeclarativeSchema(`module default {\n${issuesSrc}\n}`, { legacySyntaxCompat: true });
const registry = new AnnotationRegistry(schema.abstractAnnotations ?? []);

const makeResolver = () => new TypeMemberResolver(schema.types, registry);
const decl = (name: string) => {
  const found = schema.types.find((t) => t.name === name);
  if (!found) throw new Error(`type ${name} not found in issues schema`);
  return found;
};
const names = (members: TypeMember[]) => members.map((m) => m.name);

describe("TypeMemberResolver", () => {
  it("returns a root type's own members", () => {
    expect(names(makeResolver().resolveMembers(decl("Named")))).toEqual(["name"]);
  });

  it("folds inherited members in, before own members, with no duplicates", () => {
    const resolved = names(makeResolver().resolveMembers(decl("Issue")));
    // inherited from Named / Owned / Text
    expect(resolved).toContain("name");
    expect(resolved).toContain("owner");
    expect(resolved).toContain("body");
    // own
    expect(resolved).toContain("number");
    expect(resolved).toContain("status");
    // inherited come before own (owner is inherited, number is own)
    expect(resolved.indexOf("owner")).toBeLessThan(resolved.indexOf("number"));
    // each name appears exactly once (overloads collapse, not duplicate)
    expect(new Set(resolved).size).toBe(resolved.length);
  });

  it("merges an overloaded property without duplicating it, keeping the added constraint", () => {
    // Dictionary overloads Named.name, adding `delegated constraint exclusive`.
    const nameMembers = makeResolver().resolveMembers(decl("Dictionary")).filter((m) => m.name === "name");
    expect(nameMembers).toHaveLength(1);
    const nameMember = nameMembers[0];
    expect(nameMember.kind).toBe("property");
    if (nameMember.kind === "property") {
      expect(nameMember.constraints.some((c) => c.name.includes("exclusive"))).toBe(true);
    }
  });

  it("merges link properties from an overloaded link (overload adds, base preserved)", () => {
    // Issue overloads Owned.owner adding `since`; Owned.owner already has `note`.
    const owner = makeResolver().resolveMembers(decl("Issue")).find((m) => m.name === "owner");
    expect(owner?.kind).toBe("link");
    if (owner && owner.kind === "link") {
      const propNames = owner.properties.map((p) => p.name);
      expect(propNames).toContain("since"); // from the overload
      expect(propNames).toContain("note"); // preserved from the base
    }
  });

  it("hands out independent clones — caching does not alias", () => {
    const resolver = makeResolver();
    const first = resolver.resolveMembers(decl("Issue"));
    const second = resolver.resolveMembers(decl("Issue"));
    expect(first).not.toBe(second);
    expect(names(first)).toEqual(names(second));
    // mutating a returned list must not corrupt the cache
    first.pop();
    expect(names(resolver.resolveMembers(decl("Issue")))).toEqual(names(second));
  });
});
