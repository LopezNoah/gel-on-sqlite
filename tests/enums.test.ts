// tests/engine.enums.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { QueryHarness } from "./utils.js";

describe("EdgeQL Enums (SPEC-PARITY)", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      schema: "enums",
      dbFile: "./tests/.artifacts/enums.sqlite",
    });
  });

  it("test_edgeql_enums_assignment_01", () => {
    h.query(`INSERT default::Foo { color := 'RED' };`);
    const res = h.query(`SELECT default::Foo { color };`);
    expect(res.rows).toEqual([{ color: "RED" }]);
  });

  it("test_edgeql_enums_assignment_02", () => {
    h.query(`INSERT default::Foo { color := 'RED' };`);
    h.query(`UPDATE default::Foo SET { color := 'GREEN' };`);
    const res = h.query(`SELECT default::Foo { color };`);
    expect(res.rows).toEqual([{ color: "GREEN" }]);
  });

  it("test_edgeql_enums_assignment_03", () => {
    h.query(`INSERT default::Bar { color := 'RED' };`);
    const res = h.query(`SELECT default::Bar { color };`);
    expect(res.rows).toEqual([{ color: "RED" }]);
  });

  it("test_edgeql_enums_assignment_04", () => {
    h.query(`INSERT default::Bar { color := 'RED' };`);
    h.query(`UPDATE default::Bar SET { color := 'GREEN' };`);
    const res = h.query(`SELECT default::Bar { color };`);
    expect(res.rows).toEqual([{ color: "GREEN" }]);
  });

  it("test_edgeql_enums_invalid_value", () => {
    expect(() => h.query(`INSERT default::Foo { color := 'YELLOW' };`)).toThrow(
      /invalid input value for enum/
    );
  });

  it("test_edgeql_enums_case_sensitive", () => {
    expect(() => h.query(`INSERT default::Foo { color := 'red' };`)).toThrow(
      /invalid input value for enum/
    );
  });

  it("test_edgeql_enums_multi_statement", () => {
    h.script(`INSERT default::Foo { color := 'BLUE' }; SELECT default::Foo { color };`);
  });

  it("test_edgeql_enums_cast_01", () => {
    h.assertQueryResult(`SELECT <color_enum_t>{'RED', 'GREEN', 'BLUE'};`,
      ["RED", "GREEN", "BLUE"]
    );
  });

  it("test_edgeql_enums_cast_02_invalid", () => {
    expect(() => h.query(`SELECT <color_enum_t>'YELLOW';`)).toThrow(
      /invalid input value for enum/
    );
  });

  it("test_edgeql_enums_cast_03_case_sensitive", () => {
    expect(() => h.query(`SELECT <color_enum_t>'red';`)).toThrow(
      /invalid input value for enum/
    );
  });

  it("test_edgeql_enums_cast_04", () => {
    h.query(`INSERT default::Foo { color := 'BLUE' };`);
    expect(() =>
      h.query(`SELECT 'The test color is: ' ++ default::Foo.color;`)
    ).toThrow(
      /operator '\+\+' cannot be applied to operands of type 'std::str' and 'default::color_enum_t'/
    );
  });

  it("test_edgeql_enums_cast_05", () => {
    h.query(`INSERT default::Foo { color := 'BLUE' };`);
    const res = h.query(
      `SELECT 'The test color is: ' ++ <str>default::Foo.color;`
    );
    expect(res.rows).toEqual(["The test color is: BLUE"]);
  });

  it("test_edgeql_enums_pathsyntax_01", () => {
    expect(() => h.query(`SELECT color_enum_t`)).toThrow(
      /enum path expression lacks an enum member name/
    );

    expect(() =>
      h.query(`WITH e := color_enum_t SELECT e.RED`)
    ).toThrow(/enum path expression lacks an enum member name/);

    expect(() => h.query(`SELECT color_enum_t@RED`)).toThrow(
      /unexpected reference to link property/
    );

    expect(() => h.query(`SELECT color_enum_t.<RED`)).toThrow(
      /enum types do not support backlink/
    );

    expect(() =>
      h.query(`SELECT color_enum_t[IS color_enum_t].RED`)
    ).toThrow(/an enum member name must follow enum type name in the path/);

    expect(() => h.query(`SELECT color_enum_t.RED.GREEN`)).toThrow(
      /invalid property reference on an expression of primitive type/
    );

    expect(() =>
      h.query(`WITH x := color_enum_t.RED SELECT x.GREEN`)
    ).toThrow(/invalid property reference on an expression of primitive type/);

    expect(() => h.query(`SELECT color_enum_t.RAD`)).toThrow(
      /enum has no member called 'RAD'/
    );
  });

  it("test_edgeql_enums_pathsyntax_02", () => {
    let res = h.query(`SELECT color_enum_t.GREEN;`);
    expect(res.rows).toEqual(["GREEN"]);

    res = h.query(`SELECT default::color_enum_t.BLUE;`);
    expect(res.rows).toEqual(["BLUE"]);

    res = h.query(`WITH x := default::color_enum_t.RED SELECT x;`);
    expect(res.rows).toEqual(["RED"]);
  });

  it("test_edgeql_enums_json_cast_01", () => {
    const res = h.query(`SELECT <json><color_enum_t>'RED';`);
    expect(res.rows).toEqual(['"RED"']);

    const res2 = h.query(`SELECT <color_enum_t><json>'RED';`);
    expect(res2.rows).toEqual(["RED"]);

    const res3 = h.query(`SELECT <color_enum_t>'RED';`);
    expect(res3.rows).toEqual(["RED"]);
  });

  it("test_edgeql_enums_json_cast_02", () => {
    expect(() =>
      h.query(`SELECT <color_enum_t><json>'BANANA';`)
    ).toThrow(/invalid input value for enum.*color_enum_t.*BANANA/);
  });

  it("test_edgeql_enums_json_cast_03", () => {
    expect(() => h.query(`SELECT <color_enum_t><json>12;`)).toThrow(
      /expected JSON string or null.*got JSON number/
    );
  });
});
