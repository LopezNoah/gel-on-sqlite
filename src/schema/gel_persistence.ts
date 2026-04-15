import type { SQLiteDatabase } from "../runtime/database.js";
import { SchemaSnapshot, qualifiedTypeName } from "../schema/schema.js";
import type {
  AccessPolicyDef,
  AnnotationDef,
  ComputedDef,
  ComputedValuePart,
  ConstraintDef,
  FieldDef,
  FunctionBodyDef,
  FunctionDef,
  FunctionParamDef,
  LinkDef,
  LinkPropertyDef,
  MutationRewriteDef,
  MutationRewriteExpr,
  ScalarType,
  ScalarValue,
  TriggerDef,
  TypeDef,
} from "../types.js";
import { GEL_SCHEMA_DDL, GEL_TABLE_NAMES } from "./gel_schema_tables.js";
import type {
  AccessPolicyMetadata,
  AnnotationMetadata,
  FunctionMetadata,
  LinkMetadata,
  ObjectTypeMetadata,
  PropertyMetadata,
  RewriteMetadata,
  ScalarTypeMetadata,
  TriggerMetadata,
} from "./gel_metadata_schemas.js";
import { validateMetadata } from "./gel_metadata_schemas.js";
import { buildAnnotationsBySubject, insertAnnotationRecord, resolveAnnotations } from "./annos.js";
import type { AnnotationRow } from "./annos.js";

export const ensureGelSchemaTables = (db: SQLiteDatabase): void => {
  for (const ddl of GEL_SCHEMA_DDL) {
    db.prepare(ddl).run();
  }
};

export const hasGelSchemaTables = (db: SQLiteDatabase): boolean => {
  const result = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name IN (${GEL_TABLE_NAMES.map(() => "?").join(",")})`,
    )
    .all(...GEL_TABLE_NAMES)[0] as { cnt: number } | undefined;
  return result?.cnt === GEL_TABLE_NAMES.length;
};

export const serializeSchemaToInstdata = (db: SQLiteDatabase, snapshot: SchemaSnapshot): void => {
  const types = snapshot.listTypes();
  const functions = snapshot.listFunctions();

  const serialized = {
    types: types.map(serializeTypeDef),
    functions: functions.map(serializeFunctionDef),
  };

  const existing = db.prepare(`SELECT data FROM gel_instdata WHERE key = ?`).all("schema")[0] as
    | { data: string }
    | undefined;

  if (existing) {
    db.prepare(`UPDATE gel_instdata SET data = ? WHERE key = ?`).run(JSON.stringify(serialized), "schema");
  } else {
    db.prepare(`INSERT INTO gel_instdata (key, data) VALUES (?, ?)`).run("schema", JSON.stringify(serialized));
  }
};

export const deserializeSchemaFromInstdata = (db: SQLiteDatabase): SchemaSnapshot | null => {
  const row = db.prepare(`SELECT data FROM gel_instdata WHERE key = ?`).all("schema")[0] as
    | { data: string }
    | undefined;

  if (!row) return null;

  try {
    const parsed = JSON.parse(row.data) as {
      types: ReturnType<typeof serializeTypeDef>[];
      functions: ReturnType<typeof serializeFunctionDef>[];
    };

    const types = parsed.types.map(deserializeTypeDef);
    const functions = parsed.functions.map(deserializeFunctionDef);

    return new SchemaSnapshot(types, functions);
  } catch {
    return null;
  }
};

export const serializeSchemaToGelTables = (db: SQLiteDatabase, snapshot: SchemaSnapshot): void => {
  db.prepare(`DELETE FROM gel_schema`).run();
  db.prepare(`DELETE FROM gel_backend`).run();
  db.prepare(`DELETE FROM gel_bases`).run();
  db.prepare(`DELETE FROM gel_ancestors`).run();
  db.prepare(`DELETE FROM gel_annotations`).run();
  db.prepare(`DELETE FROM gel_pointers`).run();
  db.prepare(`DELETE FROM gel_pointer_endpoints`).run();
  db.prepare(`DELETE FROM gel_subject_constraints`).run();
  db.prepare(`DELETE FROM gel_subject_indexes`).run();
  db.prepare(`DELETE FROM gel_link_properties`).run();
  db.prepare(`DELETE FROM gel_function_params`).run();
  db.prepare(`DELETE FROM gel_migration_parents`).run();
  db.prepare(`DELETE FROM gel_type_union`).run();
  db.prepare(`DELETE FROM gel_type_intersection`).run();
  db.prepare(`DELETE FROM gel_type_policies`).run();
  db.prepare(`DELETE FROM gel_type_triggers`).run();
  db.prepare(`DELETE FROM gel_pointer_rewrites`).run();
  db.prepare(`DELETE FROM gel_function_globals`).run();
  db.prepare(`DELETE FROM gel_function_permissions`).run();
  db.prepare(`DELETE FROM gel_tuple_elements`).run();
  db.prepare(`DELETE FROM gel_collection_element`).run();
  db.prepare(`DELETE FROM gel_alias_target`).run();
  db.prepare(`DELETE FROM gel_global_target`).run();
  db.prepare(`DELETE FROM gel_cast_types`).run();
  db.prepare(`DELETE FROM gel_constraint_subject`).run();
  db.prepare(`DELETE FROM gel_policy_subject`).run();
  db.prepare(`DELETE FROM gel_trigger_subject`).run();
  db.prepare(`DELETE FROM gel_rewrite_subject`).run();

  const types = snapshot.listTypes();
  const functions = snapshot.listFunctions();

  const idMap = new Map<string, string>();

  for (const typeDef of types) {
    const typeId = generateId(typeDef);
    idMap.set(qualifiedTypeName(typeDef), typeId);
  }

  for (const typeDef of types) {
    const typeId = idMap.get(qualifiedTypeName(typeDef))!;
    serializeTypeToGelTables(db, typeDef, typeId, idMap, snapshot);
  }

  for (const fn of functions) {
    const fnId = generateFunctionId(fn);
    serializeFunctionToGelTables(db, fn, fnId, idMap);
  }
};

export const deserializeSchemaFromGelTables = (db: SQLiteDatabase): SchemaSnapshot | null => {
  const rows = db.prepare(`SELECT * FROM gel_schema ORDER BY rowid`).all() as Array<{
    id: string;
    kind: string;
    name: string;
    name__internal: string;
    module: string;
    abstract: number;
    builtin: number;
    internal: number;
    parent_ids: string | null;
    metadata: string | null;
  }>;

  if (rows.length === 0) return null;

  const typeRows = rows.filter((r) => r.kind === "ObjectType");
  const functionRows = rows.filter((r) => r.kind === "Function");

  const idToRow = new Map(rows.map((r) => [r.id, r]));
  const nameToId = new Map(rows.map((r) => [r.name__internal, r.id]));

  const pointers = db.prepare(`SELECT * FROM gel_pointers`).all() as Array<{
    source_id: string;
    pointer_id: string;
  }>;

  const pointerEndpoints = db.prepare(`SELECT * FROM gel_pointer_endpoints`).all() as Array<{
    pointer_id: string;
    source_id: string;
    target_id: string;
  }>;

  const linkProps = db.prepare(`SELECT * FROM gel_link_properties`).all() as Array<{
    link_id: string;
    property_id: string;
  }>;

  const bases = db.prepare(`SELECT * FROM gel_bases ORDER BY subject_id, idx`).all() as Array<{
    subject_id: string;
    object_id: string;
    idx: number;
  }>;

  const typeAnnotations = db.prepare(`SELECT * FROM gel_annotations`).all() as unknown as AnnotationRow[];

  const typeTriggers = db.prepare(`SELECT * FROM gel_type_triggers`).all() as Array<{
    type_id: string;
    trigger_id: string;
  }>;

  const typePolicies = db.prepare(`SELECT * FROM gel_type_policies`).all() as Array<{
    type_id: string;
    policy_id: string;
  }>;

  const pointerRewrites = db.prepare(`SELECT * FROM gel_pointer_rewrites`).all() as Array<{
    pointer_id: string;
    rewrite_id: string;
  }>;

  const endpointByPointer = new Map(pointerEndpoints.map((e) => [e.pointer_id, e]));
  const pointersBySource = new Map<string, Array<{ pointer_id: string }>>();
  for (const p of pointers) {
    if (!pointersBySource.has(p.source_id)) {
      pointersBySource.set(p.source_id, []);
    }
    pointersBySource.get(p.source_id)!.push(p);
  }

  const linkPropsByLink = new Map<string, string[]>();
  for (const lp of linkProps) {
    if (!linkPropsByLink.has(lp.link_id)) {
      linkPropsByLink.set(lp.link_id, []);
    }
    linkPropsByLink.get(lp.link_id)!.push(lp.property_id);
  }

  const basesBySubject = new Map<string, Array<{ object_id: string; idx: number }>>();
  for (const b of bases) {
    if (!basesBySubject.has(b.subject_id)) {
      basesBySubject.set(b.subject_id, []);
    }
    basesBySubject.get(b.subject_id)!.push(b);
  }

  const annotationsBySubject = buildAnnotationsBySubject(typeAnnotations);

  const resolveAnnotationsForSubject = (subjectId: string): AnnotationDef[] =>
    resolveAnnotations(subjectId, annotationsBySubject, idToRow);

  const triggersByType = new Map<string, string[]>();
  for (const t of typeTriggers) {
    if (!triggersByType.has(t.type_id)) {
      triggersByType.set(t.type_id, []);
    }
    triggersByType.get(t.type_id)!.push(t.trigger_id);
  }

  const policiesByType = new Map<string, string[]>();
  for (const p of typePolicies) {
    if (!policiesByType.has(p.type_id)) {
      policiesByType.set(p.type_id, []);
    }
    policiesByType.get(p.type_id)!.push(p.policy_id);
  }

  const rewritesByPointer = new Map<string, string[]>();
  for (const r of pointerRewrites) {
    if (!rewritesByPointer.has(r.pointer_id)) {
      rewritesByPointer.set(r.pointer_id, []);
    }
    rewritesByPointer.get(r.pointer_id)!.push(r.rewrite_id);
  }

  const types: TypeDef[] = [];

  for (const typeRow of typeRows) {
    const typeId = typeRow.id;
    const pointersForType = pointersBySource.get(typeId) ?? [];

    const fields: FieldDef[] = [];
    const links: LinkDef[] = [];
    const computeds: ComputedDef[] = [];
    const triggers: TriggerDef[] = [];
    const accessPolicies: AccessPolicyDef[] = [];
    const mutationRewrites: MutationRewriteDef[] = [];
    const annotations = resolveAnnotationsForSubject(typeId);

    for (const ptr of pointersForType) {
      const ptrRow = idToRow.get(ptr.pointer_id);
      if (!ptrRow) continue;

      if (ptrRow.kind === "Property") {
        const meta = ptrRow.metadata ? (JSON.parse(ptrRow.metadata) as PropertyMetadata) : {} as PropertyMetadata;
        const endpoint = endpointByPointer.get(ptr.pointer_id);

        if (meta.computed_expr) {
          const parsedExpr = parseComputedPropertyExpr(meta.computed_expr);
          const computedDef: ComputedDef = {
            name: ptrRow.name,
            required: false,
            multi: meta.cardinality === "Many",
            kind: "property",
            expr: parsedExpr,
          };
          computeds.push(computedDef);
        } else {
          const field: FieldDef = {
            name: ptrRow.name,
            type: inferScalarType(meta.target_type_id, idToRow),
            required: meta.required ?? false,
            multi: meta.cardinality === "Many",
          };
          const fieldAnnotations = resolveAnnotationsForSubject(ptr.pointer_id);
          if (fieldAnnotations.length > 0) {
            field.annotations = fieldAnnotations;
          }
          fields.push(field);
        }

        const rewritesForPtr = rewritesByPointer.get(ptr.pointer_id) ?? [];
        for (const rewriteId of rewritesForPtr) {
          const rewriteRow = idToRow.get(rewriteId);
          if (rewriteRow && rewriteRow.kind === "Rewrite") {
            const rewriteMeta = rewriteRow.metadata
              ? (JSON.parse(rewriteRow.metadata) as RewriteMetadata)
              : ({} as RewriteMetadata);
            const expr: MutationRewriteExpr | undefined = rewriteMeta.expr
              ? parseRewriteExpr(rewriteMeta.expr)
              : undefined;
            if (rewriteMeta.kind === "Insert") {
              mutationRewrites.push({ field: ptrRow.name, onInsert: expr });
            } else if (rewriteMeta.kind === "Update") {
              mutationRewrites.push({ field: ptrRow.name, onUpdate: expr });
            }
          }
        }
      } else if (ptrRow.kind === "Link") {
        const meta = ptrRow.metadata ? (JSON.parse(ptrRow.metadata) as LinkMetadata) : {} as LinkMetadata;
        const childPropIds = linkPropsByLink.get(ptr.pointer_id) ?? [];
        const linkProperties: LinkPropertyDef[] = [];

        for (const childId of childPropIds) {
          const childRow = idToRow.get(childId);
          if (childRow && childRow.kind === "Property") {
            const childMeta = childRow.metadata
              ? (JSON.parse(childRow.metadata) as PropertyMetadata)
              : ({} as PropertyMetadata);
            const prop: LinkPropertyDef = {
              name: childRow.name,
              type: inferScalarType(childMeta.target_type_id, idToRow),
              required: childMeta.required ?? false,
            };
            const propAnnotations = resolveAnnotationsForSubject(childId);
            if (propAnnotations.length > 0) {
              prop.annotations = propAnnotations;
            }
            linkProperties.push(prop);
          }
        }

        if (meta.computed_expr) {
          computeds.push({
            name: ptrRow.name,
            required: false,
            multi: meta.cardinality === "Many",
            kind: "link",
            expr: parseComputedLinkExpr(meta.computed_expr),
          });
        } else {
          const linkAnnotations = resolveAnnotationsForSubject(ptr.pointer_id);
          const linkDef: LinkDef = {
            name: ptrRow.name,
            targetType: resolveTargetType(meta.target_type_id, idToRow),
            multi: meta.cardinality === "Many",
            properties: linkProperties.length > 0 ? linkProperties : undefined,
          };
          if (linkAnnotations.length > 0) {
            linkDef.annotations = linkAnnotations;
          }
          links.push(linkDef);
        }
      }
    }

    for (const triggerId of triggersByType.get(typeId) ?? []) {
      const triggerRow = idToRow.get(triggerId);
      if (triggerRow && triggerRow.kind === "Trigger") {
        const triggerMeta = triggerRow.metadata
          ? (JSON.parse(triggerRow.metadata) as TriggerMetadata)
          : {} as TriggerMetadata;
        triggers.push({
          name: triggerRow.name,
          event: (triggerMeta.kinds?.[0]?.toLowerCase() ?? "insert") as TriggerDef["event"],
          scope: (triggerMeta.scope?.toLowerCase() ?? "each") as TriggerDef["scope"],
          actions: [],
        });
      }
    }

    for (const policyId of policiesByType.get(typeId) ?? []) {
      const policyRow = idToRow.get(policyId);
      if (policyRow && policyRow.kind === "AccessPolicy") {
        const policyMeta = policyRow.metadata
          ? (JSON.parse(policyRow.metadata) as AccessPolicyMetadata)
          : {} as AccessPolicyMetadata;
        accessPolicies.push({
          name: policyRow.name,
          effect: (policyMeta.action?.toLowerCase() ?? "allow") as AccessPolicyDef["effect"],
          operations: (policyMeta.access_kinds?.map(
            (k) => k.toLowerCase() as AccessPolicyDef["operations"][number],
          ) ?? ["all"]) as AccessPolicyDef["operations"],
          condition: { kind: "always", value: true },
        });
      }
    }

    const baseIds = basesBySubject.get(typeId) ?? [];
    const extendsList = baseIds
      .sort((a, b) => a.idx - b.idx)
      .map((b) => {
        const baseRow = idToRow.get(b.object_id);
        return baseRow ? baseRow.name__internal : null;
      })
      .filter((n): n is string => n !== null);

    types.push({
      name: typeRow.name,
      module: typeRow.module,
      abstract: typeRow.abstract === 1,
      extends: extendsList.length > 0 ? extendsList : undefined,
      annotations: annotations.length > 0 ? annotations : undefined,
      fields,
      links: links.length > 0 ? links : undefined,
      computeds: computeds.length > 0 ? computeds : undefined,
      mutationRewrites: mutationRewrites.length > 0 ? mutationRewrites : undefined,
      triggers: triggers.length > 0 ? triggers : undefined,
      accessPolicies: accessPolicies.length > 0 ? accessPolicies : undefined,
    });
  }

  const functions: FunctionDef[] = [];
  for (const fnRow of functionRows) {
    const meta = fnRow.metadata ? (JSON.parse(fnRow.metadata) as FunctionMetadata) : ({} as FunctionMetadata);
    const params = mapFunctionMetadataParams(meta.params, idToRow);
    const language = (meta.language ?? "edgeql") as "edgeql";
    const body: FunctionBodyDef = meta.body
      ? { kind: "query", language, query: meta.body }
      : { kind: "expr", expr: { kind: "literal", value: null } };

    functions.push({
      module: fnRow.module,
      name: fnRow.name,
      params,
      returnType: typeNameFromId(meta.return_type_id, idToRow),
      returnOptional: meta.return_typemod === "OptionalType",
      returnSetOf: meta.return_typemod === "SetOfType",
      volatility: meta.volatility,
      body,
    });
  }

  return new SchemaSnapshot(types, functions);
};

export const bootstrapGelSchema = (db: SQLiteDatabase, snapshot: SchemaSnapshot): void => {
  if (!hasGelSchemaTables(db)) {
    ensureGelSchemaTables(db);
  }

  const existing = deserializeSchemaFromInstdata(db);
  if (existing) {
    return;
  }

  serializeSchemaToGelTables(db, snapshot);
  serializeSchemaToInstdata(db, snapshot);
};

const serializeTypeToGelTables = (
  db: SQLiteDatabase,
  typeDef: TypeDef,
  typeId: string,
  idMap: Map<string, string>,
  snapshot: SchemaSnapshot,
): void => {
  const qName = qualifiedTypeName(typeDef);

  const objectTypeMeta: ObjectTypeMetadata = {
    compound_type: false,
    is_from_alias: false,
    computed_fields: typeDef.computeds?.filter((c) => c.kind === "property").map((c) => c.name),
  };
  validateMetadata("ObjectType", objectTypeMeta);

  db.prepare(
    `INSERT INTO gel_schema (id, kind, name, name__internal, module, abstract, builtin, internal, parent_ids, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    typeId,
    "ObjectType",
    typeDef.name,
    qName,
    typeDef.module ?? "default",
    typeDef.abstract ? 1 : 0,
    0,
    0,
    typeDef.extends ? JSON.stringify(typeDef.extends.map((base) => idMap.get(base) ?? base)) : null,
    JSON.stringify(objectTypeMeta),
  );

  for (let i = 0; i < (typeDef.extends ?? []).length; i++) {
    const baseName = typeDef.extends![i];
    const baseId = idMap.get(baseName) ?? baseName;
    db.prepare(`INSERT INTO gel_bases (subject_id, object_id, idx) VALUES (?, ?, ?)`).run(typeId, baseId, i);
  }

  buildAncestors(db, typeId, typeDef.extends ?? [], idMap, snapshot);

  for (const ann of typeDef.annotations ?? []) {
    insertAnnotationRecord(db, typeId, ann, typeDef.module ?? "default", `${qName}@${ann.name}`);
  }

  for (const field of typeDef.fields) {
    const fieldId = `prop_${typeId}_${field.name}`;
    const targetTypeId = ensureScalarTypeRow(db, field.type);

    const propMeta: PropertyMetadata = {
      cardinality: field.multi ? "Many" : "One",
      required: field.required ?? false,
      target_type_id: targetTypeId,
      sqlite_column: field.name,
    };
    validateMetadata("Property", propMeta);

    db.prepare(
      `INSERT INTO gel_schema (id, kind, name, name__internal, module, abstract, builtin, internal, parent_ids, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      fieldId,
      "Property",
      field.name,
      `${qName}.${field.name}`,
      typeDef.module ?? "default",
      0,
      0,
      0,
      null,
      JSON.stringify(propMeta),
    );

    db.prepare(`INSERT INTO gel_pointers (source_id, pointer_id) VALUES (?, ?)`).run(typeId, fieldId);

    db.prepare(`INSERT INTO gel_pointer_endpoints (pointer_id, source_id, target_id) VALUES (?, ?, ?)`).run(
      fieldId,
      typeId,
      targetTypeId,
    );

    for (const annotation of field.annotations ?? []) {
      insertAnnotationRecord(db, fieldId, annotation, typeDef.module ?? "default", `${qName}.${field.name}@${annotation.name}`);
    }

    const rewrite = typeDef.mutationRewrites?.find((r) => r.field === field.name);
    if (rewrite) {
      if (rewrite.onInsert) {
        const rewriteId = `rewrite_${fieldId}_insert`;
        const rewriteMeta: RewriteMetadata = {
          subject_id: typeId,
          kind: "Insert",
          expr: serializeRewriteExpr(rewrite.onInsert),
        };
        validateMetadata("Rewrite", rewriteMeta);
        db.prepare(
          `INSERT INTO gel_schema (id, kind, name, name__internal, module, abstract, builtin, internal, parent_ids, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          rewriteId,
          "Rewrite",
          `${field.name}_on_insert`,
          `${qName}.${field.name}@insert`,
          typeDef.module ?? "default",
          0,
          0,
          0,
          null,
          JSON.stringify(rewriteMeta),
        );
        db.prepare(`INSERT INTO gel_pointer_rewrites (pointer_id, rewrite_id) VALUES (?, ?)`).run(fieldId, rewriteId);
      }
      if (rewrite.onUpdate) {
        const rewriteId = `rewrite_${fieldId}_update`;
        const rewriteMeta: RewriteMetadata = {
          subject_id: typeId,
          kind: "Update",
          expr: serializeRewriteExpr(rewrite.onUpdate),
        };
        validateMetadata("Rewrite", rewriteMeta);
        db.prepare(
          `INSERT INTO gel_schema (id, kind, name, name__internal, module, abstract, builtin, internal, parent_ids, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          rewriteId,
          "Rewrite",
          `${field.name}_on_update`,
          `${qName}.${field.name}@update`,
          typeDef.module ?? "default",
          0,
          0,
          0,
          null,
          JSON.stringify(rewriteMeta),
        );
        db.prepare(`INSERT INTO gel_pointer_rewrites (pointer_id, rewrite_id) VALUES (?, ?)`).run(fieldId, rewriteId);
      }
    }
  }

  for (const link of typeDef.links ?? []) {
    const linkId = `link_${typeId}_${link.name}`;
    const targetTypeId = idMap.get(link.targetType) ?? link.targetType;

    const linkMeta: LinkMetadata = {
      cardinality: link.multi ? "Many" : "One",
      required: false,
      target_type_id: targetTypeId,
    };
    validateMetadata("Link", linkMeta);

    db.prepare(
      `INSERT INTO gel_schema (id, kind, name, name__internal, module, abstract, builtin, internal, parent_ids, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      linkId,
      "Link",
      link.name,
      `${qName}.${link.name}`,
      typeDef.module ?? "default",
      0,
      0,
      0,
      null,
      JSON.stringify(linkMeta),
    );

    db.prepare(`INSERT INTO gel_pointers (source_id, pointer_id) VALUES (?, ?)`).run(typeId, linkId);

    db.prepare(`INSERT INTO gel_pointer_endpoints (pointer_id, source_id, target_id) VALUES (?, ?, ?)`).run(
      linkId,
      typeId,
      targetTypeId,
    );

    for (const annotation of link.annotations ?? []) {
      insertAnnotationRecord(db, linkId, annotation, typeDef.module ?? "default", `${qName}.${link.name}@${annotation.name}`);
    }

    for (const lp of link.properties ?? []) {
      const lpId = `lprop_${linkId}_${lp.name}`;
      const lpTargetId = ensureScalarTypeRow(db, lp.type);

      const lpMeta: PropertyMetadata = {
        cardinality: "One",
        required: lp.required ?? false,
        target_type_id: lpTargetId,
      };
      validateMetadata("Property", lpMeta);

      db.prepare(
        `INSERT INTO gel_schema (id, kind, name, name__internal, module, abstract, builtin, internal, parent_ids, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        lpId,
        "Property",
        lp.name,
        `${qName}.${link.name}@${lp.name}`,
        typeDef.module ?? "default",
        0,
        0,
        0,
        null,
        JSON.stringify(lpMeta),
      );

      db.prepare(`INSERT INTO gel_link_properties (link_id, property_id) VALUES (?, ?)`).run(linkId, lpId);

      for (const annotation of lp.annotations ?? []) {
        insertAnnotationRecord(db, lpId, annotation, typeDef.module ?? "default", `${qName}.${link.name}@${lp.name}@${annotation.name}`);
      }
    }
  }

  for (const computed of typeDef.computeds ?? []) {
    const computedId = `comp_${typeId}_${computed.name}`;
    const kind = computed.kind === "property" ? "Property" : "Link";

    const exprStr = serializeComputedExpr(computed.expr);
    const meta: PropertyMetadata | LinkMetadata =
      computed.kind === "property"
        ? { cardinality: computed.multi ? "Many" : "One", required: false, computed_expr: exprStr }
        : { cardinality: computed.multi ? "Many" : "One", required: false, computed_expr: exprStr };
    validateMetadata(kind, meta);

    db.prepare(
      `INSERT INTO gel_schema (id, kind, name, name__internal, module, abstract, builtin, internal, parent_ids, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      computedId,
      kind,
      computed.name,
      `${qName}.${computed.name}`,
      typeDef.module ?? "default",
      0,
      0,
      0,
      null,
      JSON.stringify(meta),
    );

    db.prepare(`INSERT INTO gel_pointers (source_id, pointer_id) VALUES (?, ?)`).run(typeId, computedId);
  }

  for (const trigger of typeDef.triggers ?? []) {
    const triggerId = `trigger_${typeId}_${trigger.name}`;
    const triggerMeta: TriggerMetadata = {
      subject_id: typeId,
      timing: "After",
      kinds: [trigger.event.charAt(0).toUpperCase() + trigger.event.slice(1) as "Insert" | "Update" | "Delete"],
      scope: trigger.scope === "all" ? "Statement" : "Each",
    };
    validateMetadata("Trigger", triggerMeta);

    db.prepare(
      `INSERT INTO gel_schema (id, kind, name, name__internal, module, abstract, builtin, internal, parent_ids, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      triggerId,
      "Trigger",
      trigger.name,
      `${qName}.${trigger.name}`,
      typeDef.module ?? "default",
      0,
      0,
      0,
      null,
      JSON.stringify(triggerMeta),
    );

    db.prepare(`INSERT INTO gel_type_triggers (type_id, trigger_id) VALUES (?, ?)`).run(typeId, triggerId);
  }

  for (const policy of typeDef.accessPolicies ?? []) {
    const policyId = `policy_${typeId}_${policy.name}`;
    const policyMeta: AccessPolicyMetadata = {
      subject_id: typeId,
      action: policy.effect === "allow" ? "Allow" : "Deny",
      access_kinds: policy.operations.map((op) => {
        switch (op) {
          case "select":
            return "Select";
          case "insert":
            return "Insert";
          case "update_read":
          case "update_write":
            return "Update";
          case "delete":
            return "Delete";
          case "all":
            return "Select";
        }
      }),
    };
    validateMetadata("AccessPolicy", policyMeta);

    db.prepare(
      `INSERT INTO gel_schema (id, kind, name, name__internal, module, abstract, builtin, internal, parent_ids, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      policyId,
      "AccessPolicy",
      policy.name,
      `${qName}.${policy.name}`,
      typeDef.module ?? "default",
      0,
      0,
      0,
      null,
      JSON.stringify(policyMeta),
    );

    db.prepare(`INSERT INTO gel_type_policies (type_id, policy_id) VALUES (?, ?)`).run(typeId, policyId);
  }

  if (!typeDef.abstract) {
    const table = tableName(typeDef);
    db.prepare(`INSERT INTO gel_backend (gel_id, sqlite_name, aspect, is_shared) VALUES (?, ?, ?, ?)`).run(
      typeId,
      table,
      "table",
      0,
    );
  }
};

const serializeFunctionToGelTables = (
  db: SQLiteDatabase,
  fn: FunctionDef,
  fnId: string,
  idMap: Map<string, string>,
): void => {
  const qName = `${fn.module}::${fn.name}`;

  const paramMetadata = fn.params.length > 0 ? fn.params.map((param) => buildFunctionParamMetadata(param, idMap)) : undefined;
  const fnMeta: FunctionMetadata = {
    volatility: fn.volatility,
    body: fn.body.kind === "query" ? fn.body.query : undefined,
    language: fn.body.kind === "query" ? fn.body.language : undefined,
    params: paramMetadata,
    return_type_id: metadataTypeIdForTypeName(fn.returnType, idMap),
    return_typemod: computeReturnTypeMod(fn),
  };
  validateMetadata("Function", fnMeta);

  db.prepare(
    `INSERT INTO gel_schema (id, kind, name, name__internal, module, abstract, builtin, internal, parent_ids, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fnId,
    "Function",
    fn.name,
    qName,
    fn.module,
    0,
    0,
    0,
    null,
    JSON.stringify(fnMeta),
  );
};

const buildAncestors = (
  db: SQLiteDatabase,
  typeId: string,
  extendsList: string[],
  idMap: Map<string, string>,
  snapshot: SchemaSnapshot,
  depth = 0,
): void => {
  if (depth > 50) return;

  for (const baseName of extendsList) {
    const baseId = idMap.get(baseName) ?? baseName;
    const baseType = snapshot.getType(baseName);
    if (!baseType) continue;

    db.prepare(`INSERT OR IGNORE INTO gel_ancestors (subject_id, object_id, idx) VALUES (?, ?, ?)`).run(
      typeId,
      baseId,
      depth,
    );

    buildAncestors(db, typeId, baseType.extends ?? [], idMap, snapshot, depth + 1);
  }
};

const generateId = (typeDef: TypeDef): string => {
  const qName = qualifiedTypeName(typeDef);
  return `type_${qName.replace(/[^A-Za-z0-9_]/g, "_")}`;
};

const generateFunctionId = (fn: FunctionDef): string => {
  const qName = `${fn.module}::${fn.name}`;
  return `fn_${qName.replace(/[^A-Za-z0-9_]/g, "_")}`;
};

const scalarTypeId = (type: string): string => `scalar_${type}`;

const tableName = (typeDef: TypeDef): string =>
  `${(typeDef.module ?? "default").toLowerCase()}__${typeDef.name.toLowerCase()}`;

const ensureScalarTypeRow = (db: SQLiteDatabase, typeName: string): string => {
  const scalarId = scalarTypeId(typeName);
  const metadata: ScalarTypeMetadata = {
    base_type: typeName,
  };

  db.prepare(
    `INSERT OR IGNORE INTO gel_schema (id, kind, name, name__internal, module, abstract, builtin, internal, parent_ids, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    scalarId,
    "ScalarType",
    typeName,
    `std::${typeName}`,
    "std",
    0,
    0,
    0,
    null,
    JSON.stringify(metadata),
  );

  return scalarId;
};

const inferScalarType = (
  targetTypeId: string | undefined,
  idToRow: Map<string, { kind: string; name: string }>,
): ScalarType => {
  if (!targetTypeId) return "str";
  if (targetTypeId.startsWith("scalar_")) return targetTypeId.replace("scalar_", "") as ScalarType;
  const row = idToRow.get(targetTypeId);
  if (row) return row.name as ScalarType;
  return "str";
};

const resolveTargetType = (targetTypeId: string | undefined, idToRow: Map<string, { name__internal: string }>): string => {
  if (!targetTypeId) return "std::str";
  const row = idToRow.get(targetTypeId);
  if (row) return row.name__internal;
  return targetTypeId;
};

type SerializedTypeDef = {
  qName: string;
  name: string;
  module: string;
  abstract: boolean;
  extends?: string[];
  annotations?: Array<{ name: string; value: string }>;
  fields: Array<{
    name: string;
    type: string;
    required?: boolean;
    multi?: boolean;
    annotations?: AnnotationDef[];
    constraints?: ConstraintDef[];
  }>;
  links: Array<{
    name: string;
    targetType: string;
    multi?: boolean;
    required?: boolean;
    properties?: Array<{ name: string; type: string; required?: boolean; annotations?: AnnotationDef[] }>;
    annotations?: AnnotationDef[];
  }>;
  computeds: Array<{
    name: string;
    kind: "property" | "link";
    multi?: boolean;
    expr: unknown;
  }>;
  mutationRewrites?: Array<{ field: string; onInsert?: unknown; onUpdate?: unknown }>;
  triggers: Array<{ name: string; event: string; scope?: string }>;
  accessPolicies: Array<{ name: string; effect: string; operations: string[] }>;
};

type SerializedFunctionDef = {
  module: string;
  name: string;
  params: Array<{ name: string; type: string; optional?: boolean }>;
  returnType: string;
  volatility?: string;
  body: { kind: string; query?: string };
};

const serializeTypeDef = (typeDef: TypeDef): SerializedTypeDef => ({
  qName: qualifiedTypeName(typeDef),
  name: typeDef.name,
  module: typeDef.module ?? "default",
  abstract: typeDef.abstract ?? false,
  extends: typeDef.extends,
  annotations: typeDef.annotations,
  fields: typeDef.fields.map((f) => ({
    name: f.name,
    type: f.type,
    required: f.required,
    multi: f.multi,
    annotations: f.annotations,
    constraints: f.constraints,
  })),
  links:
    typeDef.links?.map((l) => ({
      name: l.name,
      targetType: l.targetType,
      multi: l.multi,
      properties: l.properties?.map((p) => ({
        name: p.name,
        type: p.type,
        required: p.required,
        annotations: p.annotations,
      })),
      annotations: l.annotations,
    })) ?? [],
  computeds:
    typeDef.computeds?.map((c) => ({
      name: c.name,
      kind: c.kind,
      multi: c.multi,
      expr: c.expr,
    })) ?? [],
  mutationRewrites: typeDef.mutationRewrites?.map((r) => ({
    field: r.field,
    onInsert: r.onInsert,
    onUpdate: r.onUpdate,
  })),
  triggers: typeDef.triggers?.map((t) => ({
    name: t.name,
    event: t.event,
    scope: t.scope,
  })) ?? [],
  accessPolicies:
    typeDef.accessPolicies?.map((p) => ({
      name: p.name,
      effect: p.effect,
      operations: p.operations,
    })) ?? [],
});

const serializeFunctionDef = (fn: FunctionDef): SerializedFunctionDef => ({
  module: fn.module,
  name: fn.name,
  params: fn.params.map((p) => ({
    name: p.name,
    type: p.type,
    optional: p.optional,
  })),
  returnType: fn.returnType,
  volatility: fn.volatility,
  body: fn.body,
});

const deserializeTypeDef = (serialized: SerializedTypeDef): TypeDef => ({
  name: serialized.name,
  module: serialized.module,
  abstract: serialized.abstract,
  extends: serialized.extends,
  annotations: serialized.annotations,
  fields: serialized.fields.map((f) => ({
    name: f.name,
    type: f.type as FieldDef["type"],
    required: f.required,
    multi: f.multi,
    annotations: f.annotations,
    constraints: f.constraints,
  })),
  links:
    serialized.links.length > 0
      ? serialized.links.map((l) => ({
          name: l.name,
          targetType: l.targetType,
          multi: l.multi,
        properties: l.properties?.map((p) => ({
            name: p.name,
            type: p.type as LinkPropertyDef["type"],
            required: p.required,
            annotations: p.annotations,
          })),
          annotations: l.annotations,
        }))
      : undefined,
  computeds:
    serialized.computeds.length > 0
      ? (serialized.computeds.map((c) => ({
          name: c.name,
          kind: c.kind,
          multi: c.multi,
          required: false,
          expr: c.expr as ComputedDef["expr"],
        })) as ComputedDef[])
      : undefined,
  mutationRewrites: serialized.mutationRewrites?.map((r) => ({
    field: r.field,
    onInsert: r.onInsert as MutationRewriteExpr,
    onUpdate: r.onUpdate as MutationRewriteExpr,
  })),
  triggers:
    serialized.triggers.length > 0
      ? serialized.triggers.map(
          (t) =>
            ({
              name: t.name,
              event: t.event as TriggerDef["event"],
              scope: t.scope as TriggerDef["scope"],
              actions: [],
            }) as TriggerDef,
        )
      : undefined,
  accessPolicies:
    serialized.accessPolicies.length > 0
      ? serialized.accessPolicies.map(
          (p) =>
            ({
              name: p.name,
              effect: p.effect as AccessPolicyDef["effect"],
              operations: p.operations as AccessPolicyDef["operations"],
              condition: { kind: "always" as const, value: true },
            }) as AccessPolicyDef,
        )
      : undefined,
});

const deserializeFunctionDef = (serialized: SerializedFunctionDef): FunctionDef => ({
  module: serialized.module,
  name: serialized.name,
  params: serialized.params,
  returnType: serialized.returnType,
  body: serialized.body as FunctionDef["body"],
  volatility: serialized.volatility as FunctionDef["volatility"],
});

const serializeComputedExpr = (expr: ComputedDef["expr"]): string => {
  if (expr.kind === "field_ref") return `.${expr.field}`;
  if (expr.kind === "literal") return String(expr.value);
  if (expr.kind === "concat") return expr.parts.map(serializeComputedExprPart).join(" ++ ");
  if (expr.kind === "function_call") return `${expr.name}(${expr.args.map((a) => JSON.stringify(a)).join(", ")})`;
  if (expr.kind === "link_aggregate") return `${expr.functionName}(.${expr.link}.${expr.field})`;
  return "";
};

const serializeComputedExprPart = (part: { kind: string; field?: string; value?: unknown }): string => {
  if (part.kind === "field_ref") return `.${part.field}`;
  if (part.kind === "literal") return String(part.value);
  return "";
};

const serializeComputedLinkExpr = (expr: ComputedDef["expr"]): string => {
  if (expr.kind === "link_ref") {
    let result = `.${expr.link}`;
    if (expr.filter) {
      result += ` { select filter .${expr.filter.field} ${expr.filter.op} ${JSON.stringify(expr.filter.value)} }`;
    }
    return result;
  }
  if (expr.kind === "backlink") {
    let result = `.<${expr.link}`;
    if (expr.sourceType) {
      result += `[is ${expr.sourceType}]`;
    }
    return result;
  }
  return "";
};

const serializeRewriteExpr = (expr: NonNullable<MutationRewriteDef["onInsert"]>): string => {
  if (expr.kind === "datetime_of_statement") return "datetime_of_statement()";
  if (expr.kind === "literal") return JSON.stringify(expr.value);
  if (expr.kind === "subject_field") return `.${expr.field}`;
  if (expr.kind === "old_field") return `__old__.${expr.field}`;
  return "";
};

const parseComputedPropertyExpr = (exprStr: string): { kind: "field_ref"; field: string } | { kind: "literal"; value: ScalarValue } | { kind: "concat"; parts: ComputedValuePart[] } | { kind: "function_call"; name: string; args: ScalarValue[] } | { kind: "link_aggregate"; functionName: "sum"; link: string; field: string } => {
  const aggregateMatch = exprStr.match(/^\s*sum\(\.([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)\)\s*$/i);
  if (aggregateMatch) {
    return {
      kind: "link_aggregate",
      functionName: "sum",
      link: aggregateMatch[1],
      field: aggregateMatch[2],
    };
  }

  if (exprStr.startsWith(".")) {
    const field = exprStr.slice(1);
    if (field.includes(" ")) {
      return { kind: "function_call", name: field.split("(")[0], args: [] };
    }
    return { kind: "field_ref", field };
  }
  return { kind: "literal", value: exprStr };
};

const parseComputedLinkExpr = (exprStr: string): { kind: "link_ref"; link: string; filter?: { field: string; op: "=" | "!=" | "like" | "ilike"; value: ScalarValue } } | { kind: "backlink"; link: string; sourceType?: string } => {
  if (exprStr.startsWith(".<")) {
    const link = exprStr.slice(2).split("[")[0];
    const sourceType = exprStr.includes("[is ") ? exprStr.split("[is ")[1]?.split("]")[0] : undefined;
    return { kind: "backlink", link, sourceType };
  }
  return { kind: "link_ref", link: exprStr.slice(1) };
};

const parseRewriteExpr = (exprStr: string): MutationRewriteExpr => {
  if (exprStr === "datetime_of_statement()") return { kind: "datetime_of_statement" };
  if (exprStr.startsWith("__old__.")) return { kind: "old_field", field: exprStr.slice(8) };
  if (exprStr.startsWith(".")) return { kind: "subject_field", field: exprStr.slice(1) };
  try {
    return { kind: "literal", value: JSON.parse(exprStr) };
  } catch {
    return { kind: "literal", value: exprStr };
  }
};

const parseScalarValueFromMetadata = (value: string | undefined | null): ScalarValue | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const typeNameFromId = (typeId: string | undefined, idToRow: Map<string, { name__internal: string }>): string => {
  if (!typeId) {
    return "std::str";
  }

  if (typeId.startsWith("scalar_")) {
    return typeId.replace(/^scalar_/, "");
  }

  const row = idToRow.get(typeId);
  if (row) {
    return row.name__internal;
  }

  return typeId;
};

const metadataTypeIdForTypeName = (typeName: string, idMap: Map<string, string>): string => {
  const normalized = typeName.includes("::") ? typeName : `default::${typeName}`;
  const mapped = idMap.get(normalized);
  if (mapped) {
    return mapped;
  }

  const simpleName = normalized.includes("::") ? normalized.split("::").pop() ?? normalized : normalized;
  return scalarTypeId(simpleName);
};

type FunctionParamMetadata = NonNullable<FunctionMetadata["params"]>[number];

const buildFunctionParamMetadata = (param: FunctionParamDef, idMap: Map<string, string>): FunctionParamMetadata => ({
  name: param.name,
  type_id: metadataTypeIdForTypeName(param.type, idMap),
  kind: param.variadic ? "VariadicParam" : param.namedOnly ? "NamedOnlyParam" : "PositionalParam",
  typemod: param.setOf ? "SetOfType" : param.optional ? "OptionalType" : "SingletonType",
  default: param.default === undefined ? undefined : JSON.stringify(param.default),
});

const mapFunctionMetadataParams = (
  metaParams: FunctionMetadata["params"] | undefined,
  idToRow: Map<string, { name__internal: string }>,
): FunctionParamDef[] =>
  (metaParams ?? []).map((param) => ({
    name: param.name,
    type: typeNameFromId(param.type_id, idToRow),
    optional: param.typemod === "OptionalType",
    setOf: param.typemod === "SetOfType",
    variadic: param.kind === "VariadicParam",
    namedOnly: param.kind === "NamedOnlyParam",
    default: parseScalarValueFromMetadata(param.default),
  }));

const computeReturnTypeMod = (fn: FunctionDef): "SingletonType" | "OptionalType" | "SetOfType" => {
  if (fn.returnSetOf) {
    return "SetOfType";
  }
  if (fn.returnOptional) {
    return "OptionalType";
  }
  return "SingletonType";
};
