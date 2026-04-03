import { afterEach, describe, expect, it } from "vitest";

import { materializeSchema, openSQLite, type SQLiteRuntime } from "../src/runtime/database.js";
import { executeQuery } from "../src/runtime/engine.js";
import { gelSchema } from "../src/schema/declarative.js";
import { schemaSnapshotFromDeclarative, typeDefsFromDeclarative } from "../src/schema/uiSchema.js";

describe("datamodel parity: annotations and inheritance", () => {
  let runtime: SQLiteRuntime | undefined;

  afterEach(() => {
    runtime?.close();
    runtime = undefined;
  });

  it("[SPEC-PARITY-DATAMODEL-ANNOTATIONS.S1][SPEC-PARITY-DATAMODEL-ANNOTATIONS.S2][SPEC-PARITY-DATAMODEL-ANNOTATIONS.S3] parses standard and user-defined annotations", () => {
    const schema = gelSchema`
      module default {
        abstract inheritable annotation admin_note {
          annotation title := 'Admin note';
        };

        type Status {
          annotation title := 'Activity status';
          annotation admin_note := 'system-critical';

          required name: str {
            annotation description := 'Display name';
          };
        }
      }
    `;

    expect(schema.abstractAnnotations).toEqual([
      {
        module: "default",
        name: "default::admin_note",
        inheritable: true,
        annotations: [{ name: "std::title", value: "Admin note" }],
      },
    ]);

    const status = schema.types.find((typeDecl) => typeDecl.name === "Status");
    expect(status?.annotations).toEqual([
      { name: "std::title", value: "Activity status" },
      { name: "default::admin_note", value: "system-critical" },
    ]);

    const name = status?.members.find((member) => member.kind === "property" && member.name === "name");
    expect(name && name.kind === "property" ? name.annotations : []).toEqual([
      { name: "std::description", value: "Display name" },
    ]);
  });

  it("[SPEC-PARITY-DATAMODEL-INHERITANCE.S1][SPEC-PARITY-DATAMODEL-INHERITANCE.S2][SPEC-PARITY-DATAMODEL-INHERITANCE.S3][SPEC-PARITY-DATAMODEL-INHERITANCE.S7] resolves member overloading and inheritable annotations", () => {
    const schema = gelSchema`
      module default {
        abstract inheritable annotation admin_note;
        abstract annotation local_note;

        abstract type Person {
          annotation admin_note := 'person-base';
          annotation local_note := 'not-inherited';
          required name: str;
          multi friends -> Person;
        }

        type Student extending Person {
          overloaded multi friends -> Student;
          required grade: int;
        }
      }
    `;

    const typeDefs = typeDefsFromDeclarative(schema);
    const student = typeDefs.find((typeDef) => typeDef.name === "Student");
    expect(student?.fields.map((field) => field.name).sort()).toEqual(["grade", "name"]);
    expect(student?.links).toEqual([{ name: "friends", targetType: "default::Student", multi: true }]);
    expect(student?.annotations).toEqual([{ name: "default::admin_note", value: "person-base" }]);
  });

  it("[SPEC-PARITY-DATAMODEL-INHERITANCE.S3] requires overloaded for inherited member redefinitions", () => {
    const schema = gelSchema`
      module default {
        abstract type Person {
          multi friends -> Person;
        }

        type Student extending Person {
          multi friends -> Student;
        }
      }
    `;

    expect(() => typeDefsFromDeclarative(schema)).toThrow(/must be declared as overloaded/);
  });

  it("[SPEC-PARITY-DATAMODEL-INHERITANCE.S1] materializes inherited properties for inserts and selects", () => {
    const declarative = gelSchema`
      module default {
        abstract type Animal {
          required species: str;
        }

        type Dog extending Animal {
          required breed: str;
        }
      }
    `;

    const schema = schemaSnapshotFromDeclarative(declarative);
    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    executeQuery(runtime.db, schema, "insert default::Dog { species := 'canine', breed := 'collie' }; ");
    const result = executeQuery(runtime.db, schema, "select default::Dog { species, breed };");
    expect(result.rows).toEqual([{ species: "canine", breed: "collie" }]);
  });
});
