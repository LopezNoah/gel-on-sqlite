import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";
import { assertQueryResult, unorderedSet } from "./python_query_test_helpers.js";

// Ported from gel/tests/test_edgeql_userddl.py. The upstream suite verifies
// the restrictions enforced on user-issued DDL: which abstract types are
// allowed in user-defined functions, which modules are read-only, what is
// supported in `CREATE FUNCTION` / `CREATE INFIX OPERATOR` / `CREATE CAST`,
// and so on.
//
// sqlite-ts is the lean runtime — it currently does not enforce most of
// these restrictions (anytype/anyreal polymorphism in user functions,
// std/ext module read-only protection, USING SQL bodies, SET OF parameters,
// CREATE INFIX OPERATOR, CREATE CAST, CREATE PSEUDO TYPE, fallback /
// force_return_cast field rejection, system-type extension, etc.).  Those
// tests are kept as `.skip` parity placeholders so the file mirrors the
// Python suite 1:1; un-skip them as the enforcement lands.

describe("TestEdgeQLUserDDL", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({});
    // Upstream `TestEdgeQLUserDDL` overrides `INTERNAL_TESTMODE = False` so
    // the engine enforces user-DDL restrictions (generic types, USING SQL,
    // SET OF params, CREATE INFIX OPERATOR, CREATE CAST, CREATE PSEUDO
    // TYPE, extending cfg::ConfigObject). Mirror that here.
    h.setStrictUserDDL(true);
  });

  it("test_edgeql_userddl_01", () => {
    expect(() => h.script(`
      CREATE FUNCTION func_01(
          a: anytype
      ) -> bool
          USING EdgeQL $$
              SELECT a IS float32
          $$;
    `)).toThrow(/cannot create.*func_01.*generic types are not supported in user-defined functions/i);
  });

  it("test_edgeql_userddl_02", () => {
    expect(() => h.script(`
      CREATE FUNCTION func_02(
          a: anyreal
      ) -> bool
          USING EdgeQL $$
              SELECT a IS float32
          $$;
    `)).toThrow(/cannot create.*func_02.*generic types are not supported in user-defined functions/i);
  });

  it("test_edgeql_userddl_03", () => {
    expect(() => h.script(`
      CREATE FUNCTION func_03(
          a: str
      ) -> anytype
          USING EdgeQL $$
              SELECT a
          $$;
    `)).toThrow(/cannot create.*func_03.*generic types are not supported in user-defined functions/i);
  });

  it("test_edgeql_userddl_04", () => {
    expect(() => h.script(`
      CREATE FUNCTION func_04(
          a: str
      ) -> anyscalar
          USING EdgeQL $$
              SELECT a
          $$;
    `)).toThrow(/cannot create.*func_04.*generic types are not supported in user-defined functions/i);
  });

  it("test_edgeql_userddl_05", () => {
    expect(() => h.script(`
      CREATE FUNCTION func_05(
          a: str
      ) -> str
          USING SQL FUNCTION 'lower';
    `)).toThrow(/cannot create.*func_05.*USING SQL FUNCTION.*not supported in user-defined functions/i);
  });

  it("test_edgeql_userddl_06", () => {
    expect(() => h.script(`
      CREATE FUNCTION func_06(
          a: str
      ) -> str
          USING SQL $$ SELECT "a" $$;
    `)).toThrow(/cannot create.*func_06.*USING SQL.*not supported in user-defined functions/i);
  });

  it("test_edgeql_userddl_07", () => {
    expect(() => h.script(`
      CREATE INFIX OPERATOR
      std::\`+\` (l: std::str, r: std::str) -> std::str
          USING SQL OPERATOR r'||';
    `)).toThrow(/user-defined operators are not supported/i);
  });

  it("test_edgeql_userddl_08", () => {
    expect(() => h.script(`
      CREATE CAST FROM std::int64 TO std::duration {
          USING SQL CAST;
          ALLOW ASSIGNMENT;
      };
    `)).toThrow(/user-defined casts are not supported/i);
  });

  it("test_edgeql_userddl_09", () => {
    expect(() => h.script(`
      CREATE FUNCTION std::func_09(
          a: str
      ) -> str
          USING EdgeQL $$
              SELECT a
          $$;
    `)).toThrow(/cannot create.*module std is read-only/i);
  });

  it("test_edgeql_userddl_10", () => {
    expect(() => h.script(`
      CREATE FUNCTION std::math::func_10(
          a: str
      ) -> str
          USING EdgeQL $$
              SELECT a
          $$;
    `)).toThrow(/cannot create.*module std is read-only/i);
  });

  it("test_edgeql_userddl_11", () => {
    expect(() => h.script(`
      CREATE TYPE std::Foo_11;
    `)).toThrow(/cannot create.*module std is read-only/i);
  });

  it("test_edgeql_userddl_12", () => {
    expect(() => h.script(`
      CREATE TYPE std::math::Foo_11;
    `)).toThrow(/cannot create.*module std is read-only/i);
  });

  it("test_edgeql_userddl_13", () => {
    expect(() => h.script(`
      DROP TYPE std::Object;
    `)).toThrow(/cannot delete.*module std is read-only/i);
  });

  it("test_edgeql_userddl_15", () => {
    expect(() => h.script(`
      ALTER TYPE std::Object {
          CREATE PROPERTY foo_15 -> std::str;
      };
    `)).toThrow(/cannot alter.*module std is read-only/i);
  });

  it("test_edgeql_userddl_17", () => {
    expect(() => h.script(`
      DROP MODULE std;
    `)).toThrow(/cannot delete.*module std is read-only/i);
  });

  it("test_edgeql_userddl_18", () => {
    expect(() => h.script(`
      DROP MODULE std::math;
    `)).toThrow(/cannot delete.*module std is read-only/i);
  });

  it("test_edgeql_userddl_19", () => {
    expect(() => h.script(`
      CREATE FUNCTION func_19(
          a: SET OF str
      ) -> bool
          USING EdgeQL $$
              SELECT EXISTS a
          $$;
    `)).toThrow(/cannot create.*func_19.*SET OF parameters in user-defined EdgeQL functions are not supported/i);
  });

  it.skip("test_edgeql_userddl_20 [xerror: engine does not apply user-defined functions per-element on multi-set arguments — first SELECT returns {'q','a'} correctly, second yields count 1 instead of 4]", () => {
    h.script(`
      CREATE FUNCTION func_20(
          a: str
      ) -> SET OF str
          USING EdgeQL $$
              SELECT {a, 'a'}
          $$;
    `);
    assertQueryResult(
      h,
      `SELECT func_20('q');`,
      unorderedSet(['q', 'a']),
    );
    assertQueryResult(
      h,
      `SELECT count(func_20({'q', 'w'}));`,
      [4],
    );
  });

  it("test_edgeql_userddl_21", () => {
    expect(() => h.script(`
      CREATE FUNCTION func(
          a: str
      ) -> bool
      {
          USING EdgeQL $$
              SELECT True;
          $$;
          SET force_return_cast := true;
      };
    `)).toThrow(/'force_return_cast' is not a valid field/i);
  });

  it("test_edgeql_userddl_22", () => {
    h.script(`
      CREATE ABSTRACT CONSTRAINT uppercase {
          CREATE ANNOTATION title := "Upper case constraint";
          USING (str_upper(__subject__) = __subject__);
          SET errmessage := "{__subject__} is not in upper case";
      };

      CREATE SCALAR TYPE upper_str EXTENDING str {
          CREATE CONSTRAINT uppercase
      };
    `);
    assertQueryResult(
      h,
      `SELECT <upper_str>'123_HELLO';`,
      unorderedSet(['123_HELLO']),
    );
  });

  it("test_edgeql_userddl_23", () => {
    expect(() => h.script(`CREATE PSEUDO TYPE foo;`))
      .toThrow(/user-defined pseudo types are not supported/i);
  });

  it("test_edgeql_userddl_24", () => {
    h.script(`
      CREATE SCALAR TYPE Slug EXTENDING str {
          CREATE CONSTRAINT regexp(r'^[a-z0-9][.a-z0-9-]+$')
      };
      CREATE ABSTRACT TYPE Named {
          CREATE REQUIRED PROPERTY name -> Slug
      };
      CREATE TYPE User EXTENDING Named;
    `);

    h.script(`
      ALTER TYPE Named {
          CREATE INDEX ON (__subject__.name)
      };
    `);
  });

  it("test_edgeql_userddl_25", () => {
    expect(() => h.script(`
      CREATE FUNCTION func_25(
          a: bool
      ) -> bool {
          SET fallback := true;
          USING (
              NOT a
          );
      }
    `)).toThrow(/'fallback' is not a valid field/i);
  });

  it("test_edgeql_userddl_26", () => {
    h.script(`
      CREATE FUNCTION func_26(
          a: bool
      ) -> bool {
          USING (
              NOT a
          );
      }
    `);

    expect(() => h.script(`
      ALTER FUNCTION func_26(
          a: bool
      ) {
          SET fallback := true;
      }
    `)).toThrow(/'fallback' is not a valid field/i);
  });

  it("test_edgeql_userddl_27", () => {
    h.script(`
      CREATE FUNCTION func_27(
          a: bool
      ) -> bool {
          USING (
              NOT a
          );
      }
    `);

    expect(() => h.script(`
      ALTER FUNCTION func_27(
          a: bool
      ) {
          # Even altering to set fallback to False should not be
          # allowed in user-space.
          SET fallback := false;
      }
    `)).toThrow(/'fallback' is not a valid field/i);
  });

  it("test_edgeql_userddl_28", () => {
    expect(() => h.script(`
      create type Foo extending cfg::ConfigObject;
    `)).toThrow(/cannot extend system type/i);
  });

  it("test_edgeql_userddl_29", () => {
    h.script(`
      configure session set __internal_testmode := true;
      create module ext::_test;
      create type ext::_test::X extending std::BaseObject;
      configure session reset __internal_testmode;
    `);

    expect(() => h.script(`create module ext::_test::foo;`))
      .toThrow(/module ext is read-only/i);
    expect(() => h.script(`create type ext::_test::foo;`))
      .toThrow(/module ext is read-only/i);
    expect(() => h.script(`alter type ext::_test::X { create property x -> str };`))
      .toThrow(/module ext is read-only/i);
    expect(() => h.script(`drop type ext::_test::X;`))
      .toThrow(/module ext is read-only/i);
  });

  it.skip("test_edgeql_userddl_all_extensions_01 [xerror: sqlite-ts does not support START MIGRATION / POPULATE MIGRATION / COMMIT MIGRATION]", () => {
    // Install all extensions and then delete them all. Upstream toggles
    // `using future warn_old_scoping;` between migrations to verify the
    // scoping-future flag round-trips with extensions enabled. sqlite-ts
    // has no migration session machinery yet, so this is left as a parity
    // placeholder.
    const exts = h.query(`select distinct sys::ExtensionPackage.name`).rows as string[];

    h.script(`
      START MIGRATION TO {
          using future warn_old_scoping;
          module default { }
      };
      POPULATE MIGRATION;
      COMMIT MIGRATION;
    `);

    const extCommands = exts.map((ext) => `using extension ${ext};\n`).join("");
    h.script(`
      START MIGRATION TO {
          using future warn_old_scoping;
          ${extCommands}
          module default { }
      };
      POPULATE MIGRATION;
      COMMIT MIGRATION;
    `);

    h.query(`describe current database config as ddl`);
    h.query(`describe instance config as ddl`);

    h.script(`
      START MIGRATION TO {
          ${extCommands}
          module default { }
      };
      POPULATE MIGRATION;
      COMMIT MIGRATION;
    `);

    h.script(`
      START MIGRATION TO {
          using future warn_old_scoping;
          ${extCommands}
          module default { }
      };
      POPULATE MIGRATION;
      COMMIT MIGRATION;
    `);

    h.script(`
      START MIGRATION TO {
          module default { }
      };
      POPULATE MIGRATION;
      COMMIT MIGRATION;
    `);
  });
});
