import { describe, expect, it } from "vitest";
import { SchemaSnapshot } from "../src/schema/schema.js";
import { renderSchemaSQL, tableNameForType, collectFields, collectLinks, usesLinkTable, inlineColumnName, linkTableName, multiPropertyTableName } from "../src/codegen/sql.js";
import { qualifiedTypeName } from "../src/schema/schema.js";

// --------------------------------------------------------------------------
// Helper: count occurrences of a substring in a string
// --------------------------------------------------------------------------
const countOccurrences = (haystack: string, needle: string): number => {
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
};

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("codegen/sql — naming helpers", () => {
  it("tableNameForType lowercases and replaces :: with __", () => {
    expect(tableNameForType("default::User")).toBe("default__user");
    expect(tableNameForType("myModule::MyType")).toBe("mymodule__mytype");
    expect(tableNameForType("Foo")).toBe("foo");
  });
});

describe("codegen/sql — inheritance-aware collection", () => {
  it("collectFields includes inherited fields and deduplicates", () => {
    const schema = new SchemaSnapshot([
      {
        name: "Named",
        module: "default",
        abstract: true,
        fields: [{ name: "name", type: "str", required: true }],
      },
      {
        name: "User",
        module: "default",
        extends: ["default::Named"],
        fields: [{ name: "email", type: "str", required: true }],
      },
    ]);

    const userFields = collectFields("default::User", schema, true);
    const fieldNames = userFields.map((f) => f.name);
    expect(fieldNames).toContain("name");
    expect(fieldNames).toContain("email");
    expect(fieldNames.length).toBe(2);
  });

  it("collectLinks includes inherited links", () => {
    const schema = new SchemaSnapshot([
      {
        name: "Content",
        module: "default",
        abstract: true,
        fields: [],
        links: [{ name: "author", targetType: "default::User" }],
      },
      {
        name: "Post",
        module: "default",
        extends: ["default::Content"],
        fields: [],
        links: [{ name: "category", targetType: "default::Category" }],
      },
      {
        name: "Category",
        module: "default",
        fields: [{ name: "name", type: "str" }],
      },
    ]);

    const postLinks = collectLinks("default::Post", schema, true);
    const linkNames = postLinks.map((l) => l.name);
    expect(linkNames).toContain("author");
    expect(linkNames).toContain("category");
  });
});

describe("codegen/sql — storage strategy", () => {
  it("usesLinkTable is true for multi links", () => {
    expect(usesLinkTable({ multi: true })).toBe(true);
  });

  it("usesLinkTable is true for links with properties", () => {
    expect(usesLinkTable({ properties: [{ name: "since", type: "datetime" }] })).toBe(true);
  });

  it("usesLinkTable is false for simple singleton links", () => {
    expect(usesLinkTable({})).toBe(false);
  });

  it("inlineColumnName returns {name}_id", () => {
    expect(inlineColumnName({ name: "owner", targetType: "default::User" })).toBe("owner_id");
  });

  it("linkTableName names the junction table correctly", () => {
    expect(linkTableName("default::User", { name: "posts", targetType: "default::Post", multi: true })).toBe("default__user__posts");
  });

  it("multiPropertyTableName names the multi-property table correctly", () => {
    expect(multiPropertyTableName("default::User", { name: "tags", type: "str", multi: true })).toBe("default__user__tags");
  });
});

describe("codegen/sql — renderSchemaSQL basic schema", () => {
  it("generates __gel_global_ids table first", () => {
    const schema = new SchemaSnapshot([
      {
        module: "default",
        name: "User",
        fields: [{ name: "name", type: "str", required: true }],
      },
    ]);
    const sql = renderSchemaSQL(schema);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "__gel_global_ids"');
    // The global_ids table should come before any object table
    const globalIdx = sql.indexOf("__gel_global_ids");
    const userTableIdx = sql.indexOf("default__user");
    expect(globalIdx).toBeLessThan(userTableIdx);
  });

  it("generates main object table with id + scalar columns", () => {
    const schema = new SchemaSnapshot([
      {
        module: "default",
        name: "User",
        fields: [
          { name: "name", type: "str", required: true },
          { name: "age", type: "int" },
          { name: "score", type: "float", required: true },
        ],
      },
    ]);
    const sql = renderSchemaSQL(schema);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "default__user"');
    expect(sql).toContain('"id" TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16))))');
    expect(sql).toContain('"name" TEXT NOT NULL');
    expect(sql).toContain('"age" INTEGER');
    expect(sql).toContain('"score" REAL NOT NULL');
  });

  it("skips abstract types", () => {
    const schema = new SchemaSnapshot([
      {
        module: "default",
        name: "Named",
        abstract: true,
        fields: [{ name: "name", type: "str", required: true }],
      },
      {
        module: "default",
        name: "User",
        extends: ["default::Named"],
        fields: [{ name: "email", type: "str" }],
      },
    ]);
    const sql = renderSchemaSQL(schema);
    // Should NOT have a table for Named
    expect(sql).not.toContain('"default__named"');
    // Should have a table for User
    expect(sql).toContain('"default__user"');
    // User table should include inherited 'name' field
    expect(sql).toContain('"name" TEXT NOT NULL');
    expect(sql).toContain('"email" TEXT');
  });
});

describe("codegen/sql — link storage", () => {
  it("generates inline column for singleton links", () => {
    const schema = new SchemaSnapshot([
      {
        module: "default",
        name: "User",
        fields: [{ name: "name", type: "str" }],
      },
      {
        module: "default",
        name: "Post",
        fields: [{ name: "title", type: "str" }],
        links: [{ name: "author", targetType: "default::User" }],
      },
    ]);
    const sql = renderSchemaSQL(schema);
    expect(sql).toContain('"author_id" TEXT');
  });

  it("generates inline column with FK reference for singleton links", () => {
    const schema = new SchemaSnapshot([
      {
        module: "default",
        name: "User",
        fields: [{ name: "name", type: "str" }],
      },
      {
        module: "default",
        name: "Post",
        fields: [{ name: "title", type: "str" }],
        links: [{ name: "author", targetType: "default::User" }],
      },
    ]);
    const sql = renderSchemaSQL(schema);
    expect(sql).toContain('REFERENCES "default__user"("id")');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "default__post__idx_author_id" ON "default__post" ("author_id")');
  });

  it("generates junction table for multi links", () => {
    const schema = new SchemaSnapshot([
      {
        module: "default",
        name: "User",
        fields: [{ name: "name", type: "str" }],
      },
      {
        module: "default",
        name: "Post",
        fields: [{ name: "title", type: "str" }],
        links: [{ name: "tags", targetType: "default::Tag", multi: true }],
      },
    ]);
    const sql = renderSchemaSQL(schema);
    expect(sql).toContain('"default__post__tags"');
    expect(sql).toContain('"source" TEXT NOT NULL');
    expect(sql).toContain('"target" TEXT NOT NULL');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "default__post__tags__target_source" ON "default__post__tags" ("target", "source")');
  });

  it("generates junction table with property columns for links with properties", () => {
    const schema = new SchemaSnapshot([
      {
        module: "default",
        name: "User",
        fields: [{ name: "name", type: "str" }],
      },
      {
        module: "default",
        name: "Post",
        fields: [{ name: "title", type: "str" }],
        links: [
          {
            name: "author",
            targetType: "default::User",
            properties: [{ name: "role", type: "str", required: true }],
          },
        ],
      },
    ]);
    const sql = renderSchemaSQL(schema);
    // Link with properties → uses junction table, NOT inline column
    expect(sql).toContain('"default__post__author"');
    expect(sql).toContain('"source" TEXT NOT NULL');
    expect(sql).toContain('"target" TEXT NOT NULL');
    expect(sql).toContain('"role" TEXT NOT NULL');
    // Should NOT have inline column for this link
    expect(sql).not.toContain('"author_id"');
  });

  it("omits FK for polymorphic link targets", () => {
    const schema = new SchemaSnapshot([
      {
        module: "default",
        name: "User",
        fields: [{ name: "name", type: "str" }],
      },
      {
        module: "default",
        name: "Post",
        fields: [{ name: "title", type: "str" }],
        links: [{ name: "owner", targetType: "default::User | default::Organization" }],
      },
    ]);
    const sql = renderSchemaSQL(schema);
    expect(sql).toContain('"owner_id" TEXT');
    // Should NOT have a FK reference for polymorphic targets
    expect(sql).not.toContain("REFERENCES");
  });
});

describe("codegen/sql — multi-property tables", () => {
  it("generates multi-property value table for multi fields", () => {
    const schema = new SchemaSnapshot([
      {
        module: "default",
        name: "User",
        fields: [
          { name: "name", type: "str" },
          { name: "tags", type: "str", multi: true },
        ],
      },
    ]);
    const sql = renderSchemaSQL(schema);
    expect(sql).toContain('"default__user__tags"');
    expect(sql).toContain('"source" TEXT NOT NULL');
    expect(sql).toContain('"target" TEXT NOT NULL');
  });
});

describe("codegen/sql — triggers", () => {
  it("generates global ID insert and delete triggers", () => {
    const schema = new SchemaSnapshot([
      {
        module: "default",
        name: "User",
        fields: [{ name: "name", type: "str" }],
      },
    ]);
    const sql = renderSchemaSQL(schema);
    expect(sql).toContain("gid_insert");
    expect(sql).toContain("gid_delete");
    expect(sql).toContain("__gel_global_ids");
  });

  it("generates mutation-rewrite triggers", () => {
    const schema = new SchemaSnapshot([
      {
        module: "default",
        name: "User",
        fields: [{ name: "name", type: "str" }],
        mutationRewrites: [
          {
            field: "name",
            onInsert: { kind: "literal", value: "default_name" },
          },
        ],
      },
    ]);
    const sql = renderSchemaSQL(schema);
    expect(sql).toContain("rewrite_insert_name");
    expect(sql).toContain("default_name");
  });

  it("generates custom triggers", () => {
    const schema = new SchemaSnapshot([
      {
        module: "default",
        name: "AuditLog",
        fields: [{ name: "message", type: "str" }],
        triggers: [
          {
            name: "log_insert",
            event: "insert",
            actions: [
              {
                kind: "insert",
                targetType: "EventLog",
                values: {
                  source_id: { kind: "new_field", field: "id" },
                },
              },
            ],
          },
        ],
      },
    ]);
    const sql = renderSchemaSQL(schema);
    expect(sql).toContain("custom_log_insert");
    expect(sql).toContain("AFTER INSERT");
    expect(sql).toContain("NEW.\"id\"");
  });
});

describe("codegen/sql — indexes", () => {
  it("generates indexes", () => {
    const schema = new SchemaSnapshot([
      {
        module: "default",
        name: "User",
        fields: [{ name: "email", type: "str" }],
        indexes: [{ expr: "email" }],
      },
    ]);
    const sql = renderSchemaSQL(schema);
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "default__user__idx_email"');
    expect(sql).toContain('ON "default__user" ("email")');
  });
});

describe("codegen/sql — complete end-to-end schema", () => {
  it("generates a complete, valid SQL DDL for a multi-type schema", () => {
    const schema = new SchemaSnapshot([
      {
        module: "default",
        name: "User",
        fields: [
          { name: "name", type: "str", required: true },
          { name: "email", type: "str" },
        ],
      },
      {
        module: "default",
        name: "Post",
        fields: [
          { name: "title", type: "str", required: true },
          { name: "body", type: "str" },
          { name: "author_id", type: "uuid", required: true },
        ],
        links: [
          { name: "author", targetType: "default::User" },
        ],
      },
      {
        module: "default",
        name: "Tag",
        fields: [{ name: "label", type: "str", required: true }],
      },
      {
        module: "default",
        name: "Comment",
        fields: [{ name: "text", type: "str" }],
        links: [
          { name: "post", targetType: "default::Post" },
        ],
      },
    ]);

    const sql = renderSchemaSQL(schema);

    // All tables present
    expect(sql).toContain('"default__user"');
    expect(sql).toContain('"default__post"');
    expect(sql).toContain('"default__tag"');
    expect(sql).toContain('"default__comment"');

    // Columns on Post
    expect(sql).toContain('"title" TEXT NOT NULL');
    expect(sql).toContain('"author_id" TEXT NOT NULL');

    // No orphan CREATE statements (all properly formed)
    const createTableCount = countOccurrences(sql, "CREATE TABLE");
    expect(createTableCount).toBe(5); // 4 object tables + 1 global_ids

    const createTriggerCount = countOccurrences(sql, "CREATE TRIGGER");
    expect(createTriggerCount).toBe(8); // 2 per table (gid_insert + gid_delete) * 4

    // Terminates with a semicolon
    expect(sql.endsWith(";")).toBe(true);
  });
});
