import { describe, expect, it } from "vitest";

import { gelSchema } from "../src/schema/declarative.js";

describe("declarative schema parser", () => {
  it("[SPEC-011.R1] parses Gel-like schema template strings", () => {
    const schema = gelSchema`
      module default {
        abstract type Content {
          required title: str;
          multi tags: str;
        }

        type Post extending Content {
          required author -> default::User;
          body: str;
          multi comments -> default::Comment;
        }

        type User {
          required name: str;
          multi authored -> Content {
            required role: str;
          };
        }
      }
    `;

    console.log("\n[schema_declarative] parsed modules:");
    console.log(JSON.stringify(schema.modules, null, 2));
    console.log("[schema_declarative] parsed types:");
    console.log(JSON.stringify(schema.types, null, 2));

    expect(schema.modules.map((m) => m.name)).toEqual(["default"]);
    const content = schema.types.find((t) => t.name === "Content");
    expect(content?.abstract).toBe(true);

    const post = schema.types.find((t) => t.name === "Post");
    expect(post?.extends).toEqual(["default::Content"]);
    expect(post?.members.some((m) => m.kind === "link" && m.name === "comments" && m.multi)).toBe(true);

    const user = schema.types.find((t) => t.name === "User");
    const authored = user?.members.find((m) => m.kind === "link" && m.name === "authored");
    expect(authored && authored.kind === "link" ? authored.properties : []).toEqual([
      { name: "role", scalar: "str", required: true, annotations: [] },
    ]);
  });

  it("parses permissions, mutation rewrites, triggers, and access policies", () => {
    const schema = gelSchema`
      module default {
        permission can_read_secret;

        type AuditLog {
          required action: str;
          target_name: str;
        }

        type BlogPost {
          required title: str;
          required author_id: uuid;
          modified: datetime {
            rewrite insert, update using (datetime_of_statement());
          };

          trigger write_audit after update for each
          when (__old__.title != __new__.title)
          do (insert AuditLog {
            action := 'update',
            target_name := __new__.title
          });

          access policy author_can_read
            allow select
            using (global current_user ?= .author_id);
        }
      }
    `;

    expect(schema.permissions).toEqual([{ module: "default", name: "can_read_secret" }]);
    const blogPost = schema.types.find((typeDecl) => typeDecl.name === "BlogPost");
    const modified = blogPost?.members.find((member) => member.kind === "property" && member.name === "modified");
    expect(modified && modified.kind === "property" ? modified.rewrite?.onInsert : undefined).toEqual({
      kind: "datetime_of_statement",
    });
    expect(blogPost?.triggers).toHaveLength(1);
    expect(blogPost?.accessPolicies).toHaveLength(1);
  });

  it("requires parentheses when using datetime_of_statement in rewrites", () => {
    expect(() =>
      gelSchema`
        module default {
          type Post {
            modified: datetime {
              rewrite insert using (datetime_of_statement);
            };
          }
        }
      `,
    ).toThrow(/Expected '\(' after datetime_of_statement/);
  });

  it("parses function declarations and DDL-style function mutations", () => {
    const schema = gelSchema`
      module default {
        function exclamation(word: str) -> str using (word ++ '!');
        create function duplicate(word: str) -> str using (word ++ '!');
        alter function duplicate(word: str) {
          rename to loud;
          set volatility := 'Immutable';
          using (word ++ '!!');
        };
        drop function loud(word: str);
      }
    `;

    expect(schema.functions?.map((fn) => fn.name)).toEqual(["exclamation"]);
    expect(schema.functions?.[0].params).toEqual([
      {
        name: "word",
        type: "str",
        optional: false,
        setOf: false,
        variadic: false,
        namedOnly: false,
        default: undefined,
      },
    ]);
  });
});
