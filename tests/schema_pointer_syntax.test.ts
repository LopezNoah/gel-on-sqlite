import { describe, expect, it } from "vitest";

import { parseDeclarativeSchema } from "../src/schema/declarative.js";
import { renderDeclarativeSchema } from "../src/schema/uiSchema.js";

describe("SDL pointer syntax", () => {
  it("infers omitted pointer kind for non-computed declarations", () => {
    const schema = parseDeclarativeSchema(`
      module default {
        type User {
          required name: str;
          manager: User;
          multi reports: User;
        }
      }
    `);

    const user = schema.types.find((typeDecl) => typeDecl.module === "default" && typeDecl.name === "User");
    if (!user) {
      throw new Error("expected default::User type declaration");
    }

    const name = user.members.find((member) => member.name === "name");
    expect(name?.kind).toBe("property");

    const manager = user.members.find((member) => member.name === "manager");
    expect(manager?.kind).toBe("link");
    if (!manager || manager.kind !== "link") {
      throw new Error("expected manager to be parsed as link");
    }
    expect(manager.target).toBe("default::User");

    const reports = user.members.find((member) => member.name === "reports");
    expect(reports?.kind).toBe("link");
    if (!reports || reports.kind !== "link") {
      throw new Error("expected reports to be parsed as link");
    }
    expect(reports.multi).toBe(true);
  });

  it("keeps explicit property and link declarations", () => {
    const schema = parseDeclarativeSchema(`
      module default {
        type User {
          property nickname: str;
          link manager: User;
        }
      }
    `);

    const user = schema.types.find((typeDecl) => typeDecl.module === "default" && typeDecl.name === "User");
    if (!user) {
      throw new Error("expected default::User type declaration");
    }

    const nickname = user.members.find((member) => member.name === "nickname");
    expect(nickname?.kind).toBe("property");

    const manager = user.members.find((member) => member.name === "manager");
    expect(manager?.kind).toBe("link");
  });

  it("accepts legacy pointer '->' syntax by default", () => {
    const schema = parseDeclarativeSchema(`
      module default {
        type User {
          manager -> User;
        }
      }
    `);

    const user = schema.types.find((typeDecl) => typeDecl.module === "default" && typeDecl.name === "User");
    if (!user) {
      throw new Error("expected default::User type declaration");
    }

    const manager = user.members.find((member) => member.name === "manager");
    expect(manager?.kind).toBe("link");
  });

  it("can disable legacy pointer '->' syntax", () => {
    expect(() =>
      parseDeclarativeSchema(
        `
          module default {
            type User {
              manager -> User;
            }
          }
        `,
        { legacySyntaxCompat: false },
      ),
    ).toThrow(/Legacy pointer type separator '->' is disabled/);
  });

  it("keeps '->' for function return annotations", () => {
    const parsed = parseDeclarativeSchema(
      `
        module default {
          function hello() -> str using ('ok');
        }
      `,
      { legacySyntaxCompat: false },
    );

    expect(parsed.functions?.[0]?.returnType).toBe("str");

    expect(() =>
      parseDeclarativeSchema(`
        module default {
          function hello(): str using ('ok');
        }
      `),
    ).toThrow(/Expected '->' in function declaration/);
  });

  it("renders links with ':' while keeping function return '->'", () => {
    const rendered = renderDeclarativeSchema(
      parseDeclarativeSchema(`
        module default {
          function hello() -> str using ('ok');

          type User {
            manager: User;
          }
        }
      `),
    );

    expect(rendered).toContain("function hello() -> str");
    expect(rendered).toContain("manager: User;");
    expect(rendered).not.toContain("manager -> User;");
  });
});
