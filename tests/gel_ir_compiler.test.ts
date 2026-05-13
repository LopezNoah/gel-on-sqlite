import { describe, expect, it } from "vitest";
import type { DeleteStmt, InsertStmt, SelectStmt, Set, TypeRef, UpdateStmt } from "../src/ir/gel_ir.js";
import { compileGelIRToSQL } from "../src/sql/gel_ir_compiler.js";

const buildTypeRef = (nameHint: string, id: string, overrides: Partial<TypeRef> = {}): TypeRef => ({
  kind: "type_ref",
  id,
  nameHint,
  module: "default",
  isView: false,
  isScalar: false,
  isAbstract: false,
  ...overrides,
});

const scalarPointerSet = (name: string, source: Set, target: TypeRef): Set => ({
  kind: "set",
  expr: {
    kind: "pointer",
    source,
    ptrref: {
      kind: "pointer_ref",
      id: `${name}-ptr-id`,
      name,
      shortName: name,
      outSource: source.typeref,
      outTarget: target,
      outCardinality: "at_most_one",
      inCardinality: "unknown",
      isComputed: false,
      hasProperties: false,
    },
    direction: "outbound",
    isDefinition: false,
  },
  pathId: { kind: "path_id", namespace: [], isPointerPath: true, steps: [] },
  typeref: target,
  shape: [],
  isBinding: false,
  isMaterializedRef: false,
  isSchemaAlias: false,
});

const objectPointerSet = (
  name: string,
  source: Set,
  target: TypeRef,
  direction: "outbound" | "inbound",
  outSource: TypeRef,
  outCardinality: "many" | "at_most_one" = "many",
  hasProperties = false,
): Set => ({
  kind: "set",
  expr: {
    kind: "pointer",
    source,
    ptrref: {
      kind: "pointer_ref",
      id: `${name}-ptr-id`,
      name,
      shortName: name,
      outSource,
      outTarget: target,
      outCardinality,
      inCardinality: "unknown",
      isComputed: false,
      hasProperties,
    },
    direction,
    isDefinition: false,
  },
  pathId: { kind: "path_id", namespace: [], isPointerPath: true, steps: [] },
  typeref: target,
  shape: [],
  isBinding: false,
  isMaterializedRef: false,
  isSchemaAlias: false,
});

const linkPropertySet = (name: string, source: Set, target: TypeRef): Set => ({
  kind: "set",
  expr: {
    kind: "pointer",
    source,
    ptrref: {
      kind: "pointer_ref",
      id: `${name}-ptr-id`,
      name,
      shortName: name,
      outSource: source.typeref,
      outTarget: target,
      outCardinality: "at_most_one",
      inCardinality: "unknown",
      isComputed: false,
      isLinkProperty: true,
      hasProperties: false,
    },
    direction: "outbound",
    isDefinition: false,
  },
  pathId: { kind: "path_id", namespace: [], isPointerPath: true, steps: [] },
  typeref: target,
  shape: [],
  isBinding: false,
  isMaterializedRef: false,
  isSchemaAlias: false,
});

describe("gel_ir_compiler", () => {
  it("emits UNION ALL source for inheritance-aware polymorphism", () => {
    const strType = buildTypeRef("str", "scalar-str", { isScalar: true, isAbstract: false });
    const content = buildTypeRef("Content", "content", { isAbstract: true });
    const post = buildTypeRef("Post", "post");
    const comment = buildTypeRef("Comment", "comment");
    content.children = [post, comment];

    const rootSet: Set = {
      kind: "set",
      expr: { kind: "type_root", typeref: content, skipSubtypes: false, isCachedGlobal: false },
      pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
      typeref: content,
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };

    const titleSet = scalarPointerSet("title", rootSet, strType);
    rootSet.shape = [
      {
        kind: "shape_element",
        source: rootSet,
        expr: titleSet,
        required: false,
        cardinality: "at_most_one",
      },
    ];

    const stmt: SelectStmt = {
      kind: "select_stmt",
      expr: rootSet,
      scopeTree: { kind: "scope_tree_node", uniqueId: 1, children: [], namespaces: [], fenced: false, optional: false },
      views: {},
      params: [],
      globals: [],
      requiredPermissions: [],
      serverParamConversions: [],
      serverParamConversionParams: [],
      cardinality: "many",
      multiplicity: "unknown",
      volatility: "stable",
      viewShapes: {},
      viewShapesMetadata: {},
      schemaRefs: [],
      dmlExprs: [],
      typeRewrites: {},
      singletons: [],
      triggers: [],
      warnings: [],
      unsafeIsolationDangers: [],
      implicitWrapper: false,
    };

    const artifact = compileGelIRToSQL(stmt);
    expect(artifact.sql).toContain('FROM (SELECT \'default::Post\' AS "__source_type"');
    expect(artifact.sql).toContain('UNION ALL SELECT \'default::Comment\' AS "__source_type"');
    expect(artifact.sql).toContain('"title" AS "title"');
  });

  it("compiles a basic scalar filter into parameterized SQL", () => {
    const strType = buildTypeRef("str", "scalar-str", { isScalar: true, isAbstract: false });
    const post = buildTypeRef("Post", "post");

    const rootSet: Set = {
      kind: "set",
      expr: { kind: "type_root", typeref: post, skipSubtypes: true, isCachedGlobal: false },
      pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
      typeref: post,
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };

    const titleSet = scalarPointerSet("title", rootSet, strType);
    rootSet.shape = [
      {
        kind: "shape_element",
        source: rootSet,
        expr: titleSet,
        required: false,
        cardinality: "at_most_one",
      },
    ];

    const whereSet: Set = {
      kind: "set",
      expr: {
        kind: "operator_call",
        operator: "=",
        returning: strType,
        volatility: "immutable",
        args: {
          left: {
            kind: "call_arg",
            expr: titleSet,
            cardinality: "at_most_one",
            multiplicity: "unique",
            isDefault: false,
            paramTypemod: "singleton",
            polymorphism: "not_used",
          },
          right: {
            kind: "call_arg",
            expr: {
              kind: "set",
              expr: { kind: "string_constant", value: "hello" },
              pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
              typeref: strType,
              shape: [],
              isBinding: false,
              isMaterializedRef: false,
              isSchemaAlias: false,
            },
            cardinality: "one",
            multiplicity: "unique",
            isDefault: false,
            paramTypemod: "singleton",
            polymorphism: "not_used",
          },
        },
      },
      pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
      typeref: strType,
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };

    const stmt = {
      kind: "select_stmt",
      expr: rootSet,
      where: whereSet,
      scopeTree: { kind: "scope_tree_node", uniqueId: 1, children: [], namespaces: [], fenced: false, optional: false },
      views: {},
      params: [],
      globals: [],
      requiredPermissions: [],
      serverParamConversions: [],
      serverParamConversionParams: [],
      cardinality: "many",
      multiplicity: "unknown",
      volatility: "stable",
      viewShapes: {},
      viewShapesMetadata: {},
      schemaRefs: [],
      dmlExprs: [],
      typeRewrites: {},
      singletons: [],
      triggers: [],
      warnings: [],
      unsafeIsolationDangers: [],
      implicitWrapper: false,
    } as SelectStmt;

    const artifact = compileGelIRToSQL(stmt);
    expect(artifact.sql).toContain('WHERE g0."title" = ?');
    expect(artifact.params).toEqual(["hello"]);
  });

  it("compiles outbound multi link via link table", () => {
    const strType = buildTypeRef("str", "scalar-str", { isScalar: true, isAbstract: false });
    const user = buildTypeRef("User", "user");
    const post = buildTypeRef("Post", "post");

    const rootSet: Set = {
      kind: "set",
      expr: { kind: "type_root", typeref: user, skipSubtypes: true, isCachedGlobal: false },
      pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
      typeref: user,
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };

    const postsSet = objectPointerSet("posts", rootSet, post, "outbound", user, "many");
    postsSet.shape = [
      {
        kind: "shape_element",
        source: postsSet,
        expr: scalarPointerSet("title", postsSet, strType),
        required: false,
        cardinality: "at_most_one",
      },
    ];

    rootSet.shape = [
      {
        kind: "shape_element",
        source: rootSet,
        expr: postsSet,
        required: false,
        cardinality: "many",
      },
    ];

    const stmt: SelectStmt = {
      kind: "select_stmt",
      expr: rootSet,
      scopeTree: { kind: "scope_tree_node", uniqueId: 1, children: [], namespaces: [], fenced: false, optional: false },
      views: {},
      params: [],
      globals: [],
      requiredPermissions: [],
      serverParamConversions: [],
      serverParamConversionParams: [],
      cardinality: "many",
      multiplicity: "unknown",
      volatility: "stable",
      viewShapes: {},
      viewShapesMetadata: {},
      schemaRefs: [],
      dmlExprs: [],
      typeRewrites: {},
      singletons: [],
      triggers: [],
      warnings: [],
      unsafeIsolationDangers: [],
      implicitWrapper: false,
    };

    const artifact = compileGelIRToSQL(stmt);
    expect(artifact.sql).toContain('JOIN "default__user__posts" j1 ON j1."target" = p1."id"');
    expect(artifact.sql).toContain('WHERE j1."source" = g0."id"');
  });

  it("compiles inbound backlink via inline source column", () => {
    const strType = buildTypeRef("str", "scalar-str", { isScalar: true, isAbstract: false });
    const user = buildTypeRef("User", "user");
    const post = buildTypeRef("Post", "post");

    const rootSet: Set = {
      kind: "set",
      expr: { kind: "type_root", typeref: user, skipSubtypes: true, isCachedGlobal: false },
      pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
      typeref: user,
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };

    const authoredSet = objectPointerSet("author", rootSet, post, "inbound", post, "at_most_one");
    authoredSet.shape = [
      {
        kind: "shape_element",
        source: authoredSet,
        expr: scalarPointerSet("title", authoredSet, strType),
        required: false,
        cardinality: "at_most_one",
      },
    ];

    rootSet.shape = [
      {
        kind: "shape_element",
        source: rootSet,
        expr: authoredSet,
        required: false,
        cardinality: "many",
      },
    ];

    const stmt: SelectStmt = {
      kind: "select_stmt",
      expr: rootSet,
      scopeTree: { kind: "scope_tree_node", uniqueId: 1, children: [], namespaces: [], fenced: false, optional: false },
      views: {},
      params: [],
      globals: [],
      requiredPermissions: [],
      serverParamConversions: [],
      serverParamConversionParams: [],
      cardinality: "many",
      multiplicity: "unknown",
      volatility: "stable",
      viewShapes: {},
      viewShapesMetadata: {},
      schemaRefs: [],
      dmlExprs: [],
      typeRewrites: {},
      singletons: [],
      triggers: [],
      warnings: [],
      unsafeIsolationDangers: [],
      implicitWrapper: false,
    };

    const artifact = compileGelIRToSQL(stmt);
    expect(artifact.sql).toContain('FROM (SELECT \'default::Post\' AS "__source_type"');
    expect(artifact.sql).toContain('WHERE p1."author_id" = g0."id"');
  });

  it("projects link properties and binds parameter/global placeholders", () => {
    const strType = buildTypeRef("str", "scalar-str", { isScalar: true, isAbstract: false });
    const intType = buildTypeRef("int64", "scalar-int", { isScalar: true, isAbstract: false, module: "std" });
    const boolType = buildTypeRef("bool", "scalar-bool", { isScalar: true, isAbstract: false, module: "std" });
    const user = buildTypeRef("User", "user");
    const post = buildTypeRef("Post", "post");

    const rootSet: Set = {
      kind: "set",
      expr: { kind: "type_root", typeref: user, skipSubtypes: true, isCachedGlobal: false },
      pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
      typeref: user,
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };

    const postsSet = objectPointerSet("posts", rootSet, post, "outbound", user, "many", true);
    postsSet.shape = [
      { kind: "shape_element", source: postsSet, expr: scalarPointerSet("title", postsSet, strType), required: false, cardinality: "at_most_one" },
      { kind: "shape_element", source: postsSet, expr: linkPropertySet("@rank", postsSet, intType), required: false, cardinality: "at_most_one" },
    ];
    rootSet.shape = [{ kind: "shape_element", source: rootSet, expr: postsSet, required: false, cardinality: "many" }];

    const whereSet: Set = {
      kind: "set",
      expr: {
        kind: "operator_call",
        operator: "and",
        args: {
          "0": {
            kind: "call_arg",
            expr: {
              kind: "set",
              expr: {
                kind: "operator_call",
                operator: "=",
                args: {
                  "0": { kind: "call_arg", expr: scalarPointerSet("name", rootSet, strType), cardinality: "one", multiplicity: "unique", isDefault: false, paramTypemod: "singleton", polymorphism: "not_used" },
                  "1": { kind: "call_arg", expr: { kind: "set", expr: { kind: "parameter", name: "name_param", required: true, typeref: strType }, pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] }, typeref: strType, shape: [], isBinding: false, isMaterializedRef: false, isSchemaAlias: false }, cardinality: "one", multiplicity: "unique", isDefault: false, paramTypemod: "singleton", polymorphism: "not_used" },
                },
                returning: boolType,
                volatility: "immutable",
              },
              pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
              typeref: boolType,
              shape: [],
              isBinding: false,
              isMaterializedRef: false,
              isSchemaAlias: false,
            },
            cardinality: "one",
            multiplicity: "unique",
            isDefault: false,
            paramTypemod: "singleton",
            polymorphism: "not_used",
          },
          "1": {
            kind: "call_arg",
            expr: {
              kind: "set",
              expr: {
                kind: "operator_call",
                operator: "=",
                args: {
                  "0": { kind: "call_arg", expr: { kind: "set", expr: { kind: "global_expr", name: "tenant_id", typeref: intType }, pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] }, typeref: intType, shape: [], isBinding: false, isMaterializedRef: false, isSchemaAlias: false }, cardinality: "one", multiplicity: "unique", isDefault: false, paramTypemod: "singleton", polymorphism: "not_used" },
                  "1": { kind: "call_arg", expr: { kind: "set", expr: { kind: "integer_constant", value: 7 }, pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] }, typeref: intType, shape: [], isBinding: false, isMaterializedRef: false, isSchemaAlias: false }, cardinality: "one", multiplicity: "unique", isDefault: false, paramTypemod: "singleton", polymorphism: "not_used" },
                },
                returning: boolType,
                volatility: "immutable",
              },
              pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
              typeref: boolType,
              shape: [],
              isBinding: false,
              isMaterializedRef: false,
              isSchemaAlias: false,
            },
            cardinality: "one",
            multiplicity: "unique",
            isDefault: false,
            paramTypemod: "singleton",
            polymorphism: "not_used",
          },
        },
        returning: boolType,
        volatility: "immutable",
      },
      pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
      typeref: boolType,
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };

    const stmt = {
      kind: "select_stmt",
      expr: rootSet,
      where: whereSet,
      scopeTree: { kind: "scope_tree_node", uniqueId: 1, children: [], namespaces: [], fenced: false, optional: false },
      views: {},
      params: [],
      globals: [],
      requiredPermissions: [],
      serverParamConversions: [],
      serverParamConversionParams: [],
      cardinality: "many",
      multiplicity: "unknown",
      volatility: "stable",
      viewShapes: {},
      viewShapesMetadata: {},
      schemaRefs: [],
      dmlExprs: [],
      typeRewrites: {},
      singletons: [],
      triggers: [],
      warnings: [],
      unsafeIsolationDangers: [],
      implicitWrapper: false,
    } as SelectStmt;

    const artifact = compileGelIRToSQL(stmt, { parameterValues: { name_param: "alice" }, globalValues: { tenant_id: 7 } });
    expect(artifact.sql).toContain('j1."rank"');
    expect(artifact.sql).toContain('"__source_type"');
    expect(artifact.params).toEqual(["alice", 7, 7]);
  });

  it("lowers function_call + type_cast + boolean filter composition", () => {
    const strType = buildTypeRef("str", "scalar-str", { isScalar: true, isAbstract: false });
    const intType = buildTypeRef("int64", "scalar-int", { isScalar: true, isAbstract: false, module: "std" });
    const boolType = buildTypeRef("bool", "scalar-bool", { isScalar: true, isAbstract: false, module: "std" });
    const post = buildTypeRef("Post", "post");

    const rootSet: Set = {
      kind: "set",
      expr: { kind: "type_root", typeref: post, skipSubtypes: true, isCachedGlobal: false },
      pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
      typeref: post,
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };
    rootSet.shape = [
      {
        kind: "shape_element",
        source: rootSet,
        expr: scalarPointerSet("title", rootSet, strType),
        required: false,
        cardinality: "at_most_one",
      },
    ];

    const titleRef = scalarPointerSet("title", rootSet, strType);
    const lowerTitleSet: Set = {
      kind: "set",
      expr: {
        kind: "function_call",
        functionName: "std::str_lower",
        args: {
          "0": {
            kind: "call_arg",
            expr: titleRef,
            cardinality: "at_most_one",
            multiplicity: "unique",
            isDefault: false,
            paramTypemod: "singleton",
            polymorphism: "not_used",
          },
        },
        typeref: strType,
        volatility: "immutable",
        preservesUpperCardinality: true,
      },
      pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
      typeref: strType,
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };

    const castLenSet: Set = {
      kind: "set",
      expr: {
        kind: "type_cast",
        fromType: strType,
        toType: intType,
        expr: {
          kind: "set",
          expr: {
            kind: "function_call",
            functionName: "std::len",
            args: {
              "0": {
                kind: "call_arg",
                expr: titleRef,
                cardinality: "at_most_one",
                multiplicity: "unique",
                isDefault: false,
                paramTypemod: "singleton",
                polymorphism: "not_used",
              },
            },
            typeref: intType,
            volatility: "immutable",
            preservesUpperCardinality: true,
          },
          pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
          typeref: intType,
          shape: [],
          isBinding: false,
          isMaterializedRef: false,
          isSchemaAlias: false,
        },
      },
      pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
      typeref: intType,
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };

    const lowerEq: Set = {
      kind: "set",
      expr: {
        kind: "operator_call",
        operator: "=",
        args: {
          "0": { kind: "call_arg", expr: lowerTitleSet, cardinality: "one", multiplicity: "unique", isDefault: false, paramTypemod: "singleton", polymorphism: "not_used" },
          "1": { kind: "call_arg", expr: { kind: "set", expr: { kind: "string_constant", value: "hello" }, pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] }, typeref: strType, shape: [], isBinding: false, isMaterializedRef: false, isSchemaAlias: false }, cardinality: "one", multiplicity: "unique", isDefault: false, paramTypemod: "singleton", polymorphism: "not_used" },
        },
        returning: boolType,
        volatility: "immutable",
      },
      pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
      typeref: boolType,
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };

    const lenGt: Set = {
      kind: "set",
      expr: {
        kind: "operator_call",
        operator: ">",
        args: {
          "0": { kind: "call_arg", expr: castLenSet, cardinality: "one", multiplicity: "unique", isDefault: false, paramTypemod: "singleton", polymorphism: "not_used" },
          "1": { kind: "call_arg", expr: { kind: "set", expr: { kind: "integer_constant", value: 3 }, pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] }, typeref: intType, shape: [], isBinding: false, isMaterializedRef: false, isSchemaAlias: false }, cardinality: "one", multiplicity: "unique", isDefault: false, paramTypemod: "singleton", polymorphism: "not_used" },
        },
        returning: boolType,
        volatility: "immutable",
      },
      pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
      typeref: boolType,
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };

    const whereSet: Set = {
      kind: "set",
      expr: {
        kind: "operator_call",
        operator: "and",
        args: {
          "0": { kind: "call_arg", expr: lowerEq, cardinality: "one", multiplicity: "unique", isDefault: false, paramTypemod: "singleton", polymorphism: "not_used" },
          "1": { kind: "call_arg", expr: lenGt, cardinality: "one", multiplicity: "unique", isDefault: false, paramTypemod: "singleton", polymorphism: "not_used" },
        },
        returning: boolType,
        volatility: "immutable",
      },
      pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
      typeref: boolType,
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };

    const stmt: SelectStmt = {
      kind: "select_stmt",
      expr: rootSet,
      where: whereSet,
      scopeTree: { kind: "scope_tree_node", uniqueId: 1, children: [], namespaces: [], fenced: false, optional: false },
      views: {},
      params: [],
      globals: [],
      requiredPermissions: [],
      serverParamConversions: [],
      serverParamConversionParams: [],
      cardinality: "many",
      multiplicity: "unknown",
      volatility: "stable",
      viewShapes: {},
      viewShapesMetadata: {},
      schemaRefs: [],
      dmlExprs: [],
      typeRewrites: {},
      singletons: [],
      triggers: [],
      warnings: [],
      unsafeIsolationDangers: [],
      implicitWrapper: false,
    };

    const artifact = compileGelIRToSQL(stmt);
    expect(artifact.sql).toContain("lower(COALESCE(CAST(g0.\"title\" AS TEXT), '')) = ?");
    expect(artifact.sql).toContain("CAST(length(COALESCE(CAST(g0.\"title\" AS TEXT), '')) AS INTEGER) > ?");
    expect(artifact.sql).toContain(" AND ");
    expect(artifact.params).toEqual(["hello", 3]);
  });

  it("reuses shared math stdlib SQL lowering", () => {
    const intType = buildTypeRef("int64", "scalar-int", { isScalar: true, isAbstract: false, module: "std" });
    const boolType = buildTypeRef("bool", "scalar-bool", { isScalar: true, isAbstract: false, module: "std" });
    const post = buildTypeRef("Post", "post");

    const rootSet: Set = {
      kind: "set",
      expr: { kind: "type_root", typeref: post, skipSubtypes: true, isCachedGlobal: false },
      pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
      typeref: post,
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };

    const absExpr: Set = {
      kind: "set",
      expr: {
        kind: "function_call",
        functionName: "math::abs",
        args: {
          "0": {
            kind: "call_arg",
            expr: {
              kind: "set",
              expr: { kind: "integer_constant", value: -5 },
              pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
              typeref: intType,
              shape: [],
              isBinding: false,
              isMaterializedRef: false,
              isSchemaAlias: false,
            },
            cardinality: "one",
            multiplicity: "unique",
            isDefault: false,
            paramTypemod: "singleton",
            polymorphism: "not_used",
          },
        },
        typeref: intType,
        volatility: "immutable",
        preservesUpperCardinality: true,
      },
      pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
      typeref: intType,
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };

    const whereSet: Set = {
      kind: "set",
      expr: {
        kind: "operator_call",
        operator: "=",
        args: {
          "0": { kind: "call_arg", expr: absExpr, cardinality: "one", multiplicity: "unique", isDefault: false, paramTypemod: "singleton", polymorphism: "not_used" },
          "1": { kind: "call_arg", expr: { kind: "set", expr: { kind: "integer_constant", value: 5 }, pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] }, typeref: intType, shape: [], isBinding: false, isMaterializedRef: false, isSchemaAlias: false }, cardinality: "one", multiplicity: "unique", isDefault: false, paramTypemod: "singleton", polymorphism: "not_used" },
        },
        returning: boolType,
        volatility: "immutable",
      },
      pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
      typeref: boolType,
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };

    const stmt: SelectStmt = {
      kind: "select_stmt",
      expr: rootSet,
      where: whereSet,
      scopeTree: { kind: "scope_tree_node", uniqueId: 1, children: [], namespaces: [], fenced: false, optional: false },
      views: {},
      params: [],
      globals: [],
      requiredPermissions: [],
      serverParamConversions: [],
      serverParamConversionParams: [],
      cardinality: "many",
      multiplicity: "unknown",
      volatility: "stable",
      viewShapes: {},
      viewShapesMetadata: {},
      schemaRefs: [],
      dmlExprs: [],
      typeRewrites: {},
      singletons: [],
      triggers: [],
      warnings: [],
      unsafeIsolationDangers: [],
      implicitWrapper: false,
    };

    const artifact = compileGelIRToSQL(stmt);
    expect(artifact.sql).toContain("abs(?) = ?");
    expect(artifact.params).toEqual([-5, 5]);
  });

  it("compiles insert_stmt with scalar assignments", () => {
    const strType = buildTypeRef("str", "scalar-str", { isScalar: true, isAbstract: false });
    const user = buildTypeRef("User", "user");
    const subjectSet: Set = {
      kind: "set",
      expr: { kind: "type_root", typeref: user, skipSubtypes: true, isCachedGlobal: false },
      pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
      typeref: user,
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };
    const stmt: InsertStmt = {
      kind: "insert_stmt",
      expr: subjectSet,
      subject: user,
      shape: [{
        kind: "shape_element",
        source: subjectSet,
        expr: { kind: "set", expr: { kind: "string_constant", value: "alice" }, pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] }, typeref: strType, shape: [], isBinding: false, isMaterializedRef: false, isSchemaAlias: false },
        targetPtr: { kind: "pointer_ref", id: "name", name: "name", shortName: "name", outSource: user, outTarget: strType, outCardinality: "at_most_one", inCardinality: "many", isComputed: false, hasProperties: false },
        required: false,
        cardinality: "at_most_one",
      }],
      scopeTree: { kind: "scope_tree_node", uniqueId: 1, children: [], namespaces: [], fenced: false, optional: false },
      views: {}, params: [], globals: [], requiredPermissions: [], serverParamConversions: [], serverParamConversionParams: [], cardinality: "one", multiplicity: "unknown", volatility: "modifying", viewShapes: {}, viewShapesMetadata: {}, schemaRefs: [], dmlExprs: [], typeRewrites: {}, singletons: [], triggers: [], warnings: [], unsafeIsolationDangers: [],
    };
    const artifact = compileGelIRToSQL(stmt);
    expect(artifact.sql).toBe('INSERT INTO "default__user" ("name") VALUES (?)');
    expect(artifact.params).toEqual(["alice"]);
  });

  it("compiles update_stmt and delete_stmt predicates", () => {
    const strType = buildTypeRef("str", "scalar-str", { isScalar: true, isAbstract: false });
    const boolType = buildTypeRef("bool", "scalar-bool", { isScalar: true, isAbstract: false, module: "std" });
    const user = buildTypeRef("User", "user");
    const subjectSet: Set = {
      kind: "set",
      expr: { kind: "type_root", typeref: user, skipSubtypes: true, isCachedGlobal: false },
      pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
      typeref: user,
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };
    const namePtr = scalarPointerSet("name", subjectSet, strType);
    const whereSet: Set = {
      kind: "set",
      expr: {
        kind: "operator_call",
        operator: "=",
        args: {
          "0": { kind: "call_arg", expr: namePtr, cardinality: "one", multiplicity: "unique", isDefault: false, paramTypemod: "singleton", polymorphism: "not_used" },
          "1": { kind: "call_arg", expr: { kind: "set", expr: { kind: "string_constant", value: "alice" }, pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] }, typeref: strType, shape: [], isBinding: false, isMaterializedRef: false, isSchemaAlias: false }, cardinality: "one", multiplicity: "unique", isDefault: false, paramTypemod: "singleton", polymorphism: "not_used" },
        },
        returning: boolType,
        volatility: "immutable",
      },
      pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
      typeref: boolType,
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };
    const updateStmt: UpdateStmt = {
      kind: "update_stmt",
      expr: subjectSet,
      subject: user,
      where: whereSet,
      shape: [{
        kind: "shape_element",
        source: subjectSet,
        expr: { kind: "set", expr: { kind: "string_constant", value: "alicia" }, pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] }, typeref: strType, shape: [], isBinding: false, isMaterializedRef: false, isSchemaAlias: false },
        targetPtr: { kind: "pointer_ref", id: "name", name: "name", shortName: "name", outSource: user, outTarget: strType, outCardinality: "at_most_one", inCardinality: "many", isComputed: false, hasProperties: false },
        required: false,
        cardinality: "at_most_one",
      }],
      scopeTree: { kind: "scope_tree_node", uniqueId: 1, children: [], namespaces: [], fenced: false, optional: false },
      views: {}, params: [], globals: [], requiredPermissions: [], serverParamConversions: [], serverParamConversionParams: [], cardinality: "many", multiplicity: "unknown", volatility: "modifying", viewShapes: {}, viewShapesMetadata: {}, schemaRefs: [], dmlExprs: [], typeRewrites: {}, singletons: [], triggers: [], warnings: [], unsafeIsolationDangers: [],
    };
    const updateArtifact = compileGelIRToSQL(updateStmt);
    expect(updateArtifact.sql).toContain('UPDATE "default__user" AS g0 SET "name" = ? WHERE g0."name" = ?');
    expect(updateArtifact.params).toEqual(["alicia", "alice"]);

    const deleteStmt: DeleteStmt = {
      kind: "delete_stmt",
      expr: subjectSet,
      subject: user,
      where: whereSet,
      scopeTree: { kind: "scope_tree_node", uniqueId: 1, children: [], namespaces: [], fenced: false, optional: false },
      views: {}, params: [], globals: [], requiredPermissions: [], serverParamConversions: [], serverParamConversionParams: [], cardinality: "many", multiplicity: "unknown", volatility: "modifying", viewShapes: {}, viewShapesMetadata: {}, schemaRefs: [], dmlExprs: [], typeRewrites: {}, singletons: [], triggers: [], warnings: [], unsafeIsolationDangers: [],
    };
    const deleteArtifact = compileGelIRToSQL(deleteStmt);
    expect(deleteArtifact.sql).toContain('DELETE FROM "default__user" AS g0 WHERE g0."name" = ?');
    expect(deleteArtifact.params).toEqual(["alice"]);
  });
});
