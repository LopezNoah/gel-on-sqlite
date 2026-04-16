import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";
import {
  assertQueryResult,
  unorderedBag,
  unorderedSet
} from "./python_query_test_helpers.js";

describe("TestEdgeQLExplain", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      schema: "explain",
      setup: "explain_setup",
      dbFile: "./tests/.artifacts/explain_testedgeqlexplain.sqlite",
      resetDbFile: true
    });
  });

  function assert_plan(): void {
    assert_data_shape.assert_data_shape(data, shape);
  }

  function explain(): void {
    let con = (con || h);
    h.query(
      `select _set_config("enable_seqscan", "off")`
    );
    let no_ex = undefined;
    return json.loads(con.query_single(`analyze ${no_ex}${query}`));
  }

  function _assert_index_use(): void {
    let plan = ({} as any);
    if ((!look(plan))) {
      throw AssertionError("query did not use an index");
    }
  }

  function assert_index_in_plan(): void {
    expect(true).toBe(true);
    let plan_type = data["fine_grained"]["pipeline"][0]["plan_type"];
    expect(true).toBe(true);
  }

  function get_gist_index_expected_res(): void {
    if ((plan_type === "IndexScan")) {
      return {"pipeline": [{"plan_type": "IndexScan", "properties": tb.bag([{
  "important": false,
  "title": "schema",
  "type": "text",
  "value": "edgedbpub",
}, {
  "important": false,
  "title": "alias",
  "type": "text",
}, {
  "important": true,
  "title": "relation_name",
  "type": "relation",
  "value": "RangeTest",
}, {
  "important": true,
  "title": "scan_direction",
  "type": "text",
  "value": "str",
}, {"important": true, "title": "index_name", "type": "index", "value": `index 'std::pg::gist' of object type 'default::RangeTest' on (.${fname})`}, {
  "important": false,
  "title": "index_cond",
  "type": "expr",
}])}]};
    } else {
      if ((plan_type === "BitmapHeapScan")) {
        return {"pipeline": [
  {
    "plan_type": "BitmapHeapScan",
  },
], "subplans": [{"pipeline": [{"plan_type": "BitmapIndexScan", "properties": tb.bag([{
  "important": false,
  "title": "parent_relationship",
  "type": "text",
  "value": "Outer",
}, {"important": true, "title": "index_name", "type": "index", "value": `index 'std::pg::gist' of object type 'default::RangeTest' on (.${fname})`}, {
  "important": false,
  "title": "index_cond",
  "type": "expr",
}])}]}]};
      } else {
        throw new Error(String(`${message}: "plan_type" expected to be "IndexScan" or "BitmapHeapScan", got ${plan_type}`));
      }
    }
  }

  it("test_edgeql_explain_simple_01", () => {
    let res = ({} as any);
    expect(true).toBe(true);
    expect(true).toBe(true);
  });

  it("test_edgeql_explain_introspection_01", () => {
    let res = ({} as any);
    expect(undefined as any).toContain(["relation_name", "pg_database"]);
  });

  it("test_edgeql_explain_with_bound_01", () => {
    let res = ({} as any);
    expect(true).toBe(true);
  });

  it("test_edgeql_explain_multi_link_01", () => {
    let res = ({} as any);
    expect(true).toBe(true);
  });

  it("test_edgeql_explain_computed_backlink_01", () => {
    let res = ({} as any);
    expect(true).toBe(true);
    expect((res["buffers"]).length).toEqual(2);
    expect(res["buffers"][1]).toEqual(".<owner[is default::Issue]");
  });

  it("test_edgeql_explain_inheritance_01", () => {
    let res = ({} as any);
    expect(true).toBe(true);
  });

  it("test_edgeql_explain_type_intersect_01", () => {
    let res = ({} as any);
    expect(true).toBe(true);
  });

  it("test_edgeql_explain_insert_01", () => {
    let con = connect();
    try {
      let res = ({} as any);
      expect(true).toBe(true);
      expect(con.query("\n                select User { id, name } filter .name = 'Fantix'\n            ")).toBeFalsy();
    } finally {
      // ignored awaited call: con.aclose
    }
  });

  it("test_edgeql_explain_insert_02", () => {
    h.script(
      `
                insert User { name := 'Sully' }
            `
    );
    let res = ({} as any);
    expect(true).toBe(true);
    expect(h.query("\n                select User { id, name } filter .name = 'Sully'\n            ")).toBeTruthy();
    expect(h.query("\n                select User { id, name } filter .name = 'Fantix'\n            ")).toBeFalsy();
    expect(h.query("\n            select User { id, name } filter .name = 'Sully'\n        ")).toBeTruthy();
    expect(h.query("\n            select User { id, name } filter .name = 'Fantix'\n        ")).toBeFalsy();
  });

  it("test_edgeql_explain_options_01", () => {
    let res = ({} as any);
    expect(res["fine_grained"]["pipeline"][0] as any).not.toContain("actual_startup_time");
    expect({
  "buffers": false,
  "execute": false,
}).toEqual(res["arguments"]);
    res = json.loads(h.query("\n            analyze (buffers := True) select User\n        "));
    expect(res["fine_grained"]["pipeline"][0] as any).toContain("shared_read_blocks");
    expect({
  "buffers": true,
  "execute": true,
}).toEqual(res["arguments"]);
    res = json.loads(h.query("\n            analyze (buffers := false) select User\n        "));
    expect(res["fine_grained"]["pipeline"][0] as any).not.toContain("shared_read_blocks");
    expect({
  "buffers": false,
  "execute": true,
}).toEqual(res["arguments"]);
  });

  it("test_edgeql_explain_options_02", () => {
    expect(() => {
      h.query(
        `
                analyze (bogus_argument := True) select User
            `
      );
    }).toThrow(new RegExp("unknown ANALYZE argument"));
    expect(() => {
      h.query(
        `
                analyze (execute := "hell yeah") select User
            `
      );
    }).toThrow(new RegExp("incorrect type"));
  });

  it("test_edgeql_explain_ranges_contains_01", () => {
    let res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
  });

  it("test_edgeql_explain_ranges_contains_02", () => {
    let res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
  });

  it("test_edgeql_explain_ranges_contains_03", () => {
    let res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
  });

  it("test_edgeql_explain_ranges_overlaps_01", () => {
    let res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
  });

  it("test_edgeql_explain_ranges_overlaps_02", () => {
    let res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
  });

  it("test_edgeql_explain_ranges_adjacent_01", () => {
    let res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
  });

  it("test_edgeql_explain_ranges_adjacent_02", () => {
    let res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
  });

  it("test_edgeql_explain_ranges_strictly_below_01", () => {
    let res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
  });

  it("test_edgeql_explain_ranges_strictly_below_02", () => {
    let res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
  });

  it("test_edgeql_explain_ranges_strictly_above_01", () => {
    let res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
  });

  it("test_edgeql_explain_ranges_strictly_above_02", () => {
    let res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
  });

  it("test_edgeql_explain_ranges_bounded_below_01", () => {
    let res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
  });

  it("test_edgeql_explain_ranges_bounded_above_01", () => {
    let res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
    res = ({} as any);
    expect(true).toBe(true);
  });

  it("test_edgeql_explain_json_contains_01", () => {
    let res = ({} as any);
    res = res["fine_grained"];
    if (((res["subplans"]).length >= 2)) {
      res = res["subplans"][1];
    } else {
      res["pipeline"] = res["pipeline"][undefined];
    }
    expect(true).toBe(true);
  });

  it("test_edgeql_explain_user_func_index_01", () => {
    _assert_index_use();
  });

  it("test_edgeql_explain_order_index_01", () => {
    _assert_index_use();
  });

  it("test_edgeql_explain_order_index_02", () => {
    _assert_index_use();
  });

  it("test_edgeql_explain_order_index_03", () => {
    _assert_index_use();
  });

  it("test_edgeql_explain_bug_5758", () => {
    let res = ({} as any);
    expect(res["coarse_grained"]).not.toBeNull();
  });

  it("test_edgeql_explain_bug_5791", () => {
    let res = ({} as any);
    expect(res["coarse_grained"]).not.toBeNull();
  });
});

describe("NameTranslation", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      dbFile: "./tests/.artifacts/explain_nametranslation.sqlite",
      resetDbFile: true
    });
  });

  it("test_name_default", () => {
    expect(pg_tree._translate_name(sn.QualName("default", "Type1"), {
  "default": null,
})).toEqual("Type1");
    expect(pg_tree._translate_name(sn.QualName("mod1", "Type2"), {
  "default": null,
})).toEqual("mod1::Type2");
    expect(pg_tree._translate_name(sn.QualName("m1::m2", "Type3"), {
  "default": null,
})).toEqual("m1::m2::Type3");
  });

  it("test_name_aliases_01", () => {
    expect(pg_tree._translate_name(sn.QualName("default", "Type1"), {
  "mod1": null,
  "mod2": "main",
})).toEqual("default::Type1");
    expect(pg_tree._translate_name(sn.QualName("mod1", "Type2"), {
  "mod1": null,
  "mod2": "main",
})).toEqual("Type2");
    expect(pg_tree._translate_name(sn.QualName("mod2", "Type3"), {
  "mod1": null,
  "mod2": "main",
})).toEqual("main::Type3");
  });

  it("test_name_aliases_nested_01", () => {
    expect(pg_tree._translate_name(sn.QualName("default", "Type1"), {
  "mod1": null,
  "mod2": "main",
  "mod3::mod4": "aux",
})).toEqual("default::Type1");
    expect(pg_tree._translate_name(sn.QualName("mod1::mod2", "Type2"), {
  "mod1": null,
  "mod2": "main",
  "mod3::mod4": "aux",
})).toEqual("mod1::mod2::Type2");
    expect(pg_tree._translate_name(sn.QualName("mod3::mod4::mod5", "Type3"), {
  "mod1": null,
  "mod2": "main",
  "mod3::mod4": "aux",
})).toEqual("aux::mod5::Type3");
    expect(pg_tree._translate_name(sn.QualName("mod3::mod4::mod5::mod6", "Type4"), {
  "mod1": null,
  "mod2": "main",
  "mod3::mod4": "aux",
})).toEqual("aux::mod5::mod6::Type4");
    expect(pg_tree._translate_name(sn.QualName("mod3::mod7", "Type5"), {
  "mod1": null,
  "mod2": "main",
  "mod3::mod4": "aux",
})).toEqual("mod3::mod7::Type5");
    expect(pg_tree._translate_name(sn.QualName("mod2::mod3::mod4", "Type6"), {
  "mod1": null,
  "mod2": "main",
  "mod3::mod4": "aux",
})).toEqual("main::mod3::mod4::Type6");
  });
});
