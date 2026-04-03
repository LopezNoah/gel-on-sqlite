import { afterEach, describe, expect, it } from "vitest";

import { materializeSchema, openSQLite, type SQLiteRuntime } from "../src/runtime/database.js";
import { executeQuery } from "../src/runtime/engine.js";
import { gelSchema } from "../src/schema/declarative.js";
import { functionDefsFromDeclarative, schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";

describe("datamodel parity: functions", () => {
  let runtime: SQLiteRuntime | undefined;

  afterEach(() => {
    runtime?.close();
    runtime = undefined;
  });

  it("[SPEC-PARITY-DATAMODEL-FUNCTIONS.S1][SPEC-PARITY-DATAMODEL-FUNCTIONS.S2] supports user-defined function calls and set element-wise behavior", () => {
    const declarative = gelSchema`
      module default {
        function exclamation(word: str) -> str using (word ++ '!');
      }
    `;

    const schema = schemaSnapshotFromDeclarative(declarative);
    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    const result = executeQuery(runtime.db, schema, "select { excited := exclamation({'Hello', 'World'}) }; ");
    expect(result.rows).toEqual([{ excited: ["Hello!", "World!"] }]);
  });

  it("[SPEC-PARITY-DATAMODEL-FUNCTIONS.S3] enforces modifying function single-cardinality arguments", () => {
    const declarative = gelSchema`
      module default {
        function add_user(name: str) -> str {
          volatility := 'Modifying';
          using (name ++ '!');
        };
      }
    `;

    const schema = schemaSnapshotFromDeclarative(declarative);
    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    expect(() => executeQuery(runtime!.db, schema, "select { v := add_user({'Feb', 'Mar'}) }; ")).toThrow(
      /possibly more than one element passed into modifying function/,
    );
    expect(() => executeQuery(runtime!.db, schema, "select { v := add_user({}) }; ")).toThrow(
      /possibly an empty set passed as non-optional argument into modifying function/,
    );
  });

  it("[SPEC-PARITY-DATAMODEL-FUNCTIONS.S4][SPEC-PARITY-DATAMODEL-FUNCTIONS.S5][SPEC-PARITY-DATAMODEL-FUNCTIONS.S6][SPEC-PARITY-DATAMODEL-FUNCTIONS.S9][SPEC-PARITY-DATAMODEL-FUNCTIONS.S10] parses SDL declarations, parameters, and examples", () => {
    const declarative = gelSchema`
      module default {
        function exclamation(word: str = 'hey') -> optional str {
          volatility := 'Immutable';
          using (word ++ '!');
          create annotation title := 'Exclaim';
        };
      }
    `;

    const functions = functionDefsFromDeclarative(declarative);
    expect(functions).toHaveLength(1);
    expect(functions[0].name).toBe("exclamation");
    expect(functions[0].params[0]).toMatchObject({ name: "word", type: "str", default: "hey" });
    expect(functions[0].returnOptional).toBe(true);
    expect(functions[0].volatility).toBe("Immutable");
  });

  it("[SPEC-PARITY-DATAMODEL-FUNCTIONS.S7][SPEC-PARITY-DATAMODEL-FUNCTIONS.S8][SPEC-PARITY-DATAMODEL-FUNCTIONS.S11][SPEC-PARITY-DATAMODEL-FUNCTIONS.S12][SPEC-PARITY-DATAMODEL-FUNCTIONS.S13][SPEC-PARITY-DATAMODEL-FUNCTIONS.S14] applies create/alter/drop function commands", () => {
    const declarative = gelSchema`
      module default {
        create function mysum(a: int, b: int) -> int using (a ++ b);

        alter function mysum(a: int, b: int) {
          rename to mysum2;
          set volatility := 'Stable';
          create annotation title := 'My sum';
          using (a ++ b ++ '!');
        };

        drop function mysum2(a: int, b: int);
      }
    `;

    const functions = functionDefsFromDeclarative(declarative);
    expect(functions).toHaveLength(0);
  });
});
