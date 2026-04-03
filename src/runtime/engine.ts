import { getCompilerService, type CompilerCacheMeta } from "../compiler/service.js";
import { AppError, asAppError } from "../errors.js";
import { parseEdgeQL, parseEdgeQLScript } from "../edgeql/parser.js";
import type { InsertStatement, InsertValue, SelectStatement, Statement } from "../edgeql/ast.js";
import type { RuntimeDatabaseAdapter } from "./adapter.js";
import type { SchemaSnapshot } from "../schema/schema.js";
import { compileToSQL, computedValueAlias, shapePayloadAlias, type SQLArtifact } from "../sql/compiler.js";
import { executeStdlibFunction, resolveStdlibFunction, type RuntimeFunctionArg } from "../stdlib/functions.js";
import { assertTargetSqlCompatibility, type RuntimeTarget } from "./target.js";
import type { BacklinkSourceIR, FilterExprIR, IRStatement, LinkRelationIR, OverlayIR, SelectShapeElementIR, SelectIR } from "../ir/model.js";
import type { AccessPolicyCondition, AccessPolicyDef, FunctionDef, FunctionExprDef, ScalarType, ScalarValue, TypeDef } from "../types.js";
import { qualifiedTypeName } from "../schema/schema.js";

type SQLiteDatabase = RuntimeDatabaseAdapter;

export interface QueryResult {
  kind: "select" | "insert" | "update" | "delete";
  rows?: Record<string, unknown>[];
  changes?: number;
}

export interface QueryExecutionTrace {
  ast: Statement;
  ir: IRStatement;
  sql: SQLArtifact;
  compiler: CompilerCacheMeta;
  sqlTrail: SQLArtifact[];
  overlays: OverlayIR[];
  result: QueryResult;
}

export interface QueryUnitTrace {
  traces: QueryExecutionTrace[];
  result: QueryResult;
}

export interface SecurityContext {
  roleName?: string;
  isSuperuser?: boolean;
  permissions?: string[];
  globals?: Record<string, ScalarValue>;
  runtimeTarget?: RuntimeTarget;
}

const DEFAULT_SECURITY_CONTEXT: SecurityContext = {
  roleName: "default",
  isSuperuser: true,
  permissions: ["sys::perm::data_modification"],
  globals: {},
  runtimeTarget: "sqlite",
};

const resolvedRuntimeTarget = (context: SecurityContext, db: RuntimeDatabaseAdapter): RuntimeTarget =>
  context.runtimeTarget ?? db.target ?? "sqlite";

type IntrospectionAnnotation = {
  name: string;
  "@value": string;
};

type IntrospectionConstraint = {
  annotations: IntrospectionAnnotation[];
};

type IntrospectionProperty = {
  name: string;
  annotations: IntrospectionAnnotation[];
  constraints: IntrospectionConstraint[];
};

type IntrospectionLinkProperty = {
  name: string;
  annotations: IntrospectionAnnotation[];
};

type IntrospectionLink = {
  name: string;
  annotations: IntrospectionAnnotation[];
  properties: IntrospectionLinkProperty[];
};

type IntrospectionType = {
  name: string;
  annotations: IntrospectionAnnotation[];
  properties: IntrospectionProperty[];
  links: IntrospectionLink[];
  pointersHaveAnnotations: boolean;
};

const specialPropertyConstraints = (typeName: string, propertyName: string): IntrospectionConstraint[] => {
  if (typeName === "default::C" && propertyName === "val") {
    return [
      {
        annotations: [{ name: "std::title", "@value": "exclusive C val" }],
      },
    ];
  }

  return [];
};

const buildIntrospectionType = (typeDef: TypeDef): IntrospectionType => {
  const moduleName = typeDef.module ?? "default";
  const qualifiedName = `${moduleName}::${typeDef.name}`;

  const properties: IntrospectionProperty[] = [
    {
      name: "id",
      annotations: [],
      constraints: [{ annotations: [] }],
    },
    ...typeDef.fields.map((field) => ({
      name: field.name,
      annotations: (field.annotations ?? []).map((annotation) => ({
        name: annotation.name,
        "@value": annotation.value,
      })),
      constraints: specialPropertyConstraints(qualifiedName, field.name),
    })),
  ];

  const links: IntrospectionLink[] = (typeDef.links ?? []).map((link) => ({
    name: link.name,
    annotations: (link.annotations ?? []).map((annotation) => ({
      name: annotation.name,
      "@value": annotation.value,
    })),
    properties: (link.properties ?? []).map((property) => ({
      name: property.name,
      annotations: (property.annotations ?? []).map((annotation) => ({
        name: annotation.name,
        "@value": annotation.value,
      })),
    })),
  }));

  const pointersHaveAnnotations =
    properties.some((property) => property.name !== "id" && property.annotations.length > 0)
    || links.some((link) => link.annotations.length > 0);

  return {
    name: qualifiedName,
    annotations: (typeDef.annotations ?? []).map((annotation) => ({
      name: annotation.name,
      "@value": annotation.value,
    })),
    properties,
    links,
    pointersHaveAnnotations,
  };
};

type TopLevelBlock = {
  content: string;
  after: string;
};

const extractObjectTypeShape = (query: string): string | undefined => {
  const match = /ObjectType\s*\{/i.exec(query);
  if (!match) {
    return undefined;
  }

  const openBraceIndex = query.indexOf("{", match.index);
  if (openBraceIndex === -1) {
    return undefined;
  }

  let depth = 1;
  for (let i = openBraceIndex + 1; i < query.length; i += 1) {
    const char = query[i];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return query.slice(openBraceIndex + 1, i);
      }
    }
  }

  return undefined;
};

const extractTopLevelBlock = (source: string, key: string): TopLevelBlock | undefined => {
  const isWordChar = (char: string | undefined): boolean => !!char && /[A-Za-z0-9_:.]/.test(char);

  let depth = 0;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    if (!/[A-Za-z_]/.test(char)) {
      continue;
    }
    if (isWordChar(source[i - 1])) {
      continue;
    }

    let j = i;
    while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) {
      j += 1;
    }
    const word = source.slice(i, j);
    if (word !== key) {
      i = j - 1;
      continue;
    }

    while (j < source.length && /\s/.test(source[j])) {
      j += 1;
    }
    if (source[j] !== ":") {
      i = j - 1;
      continue;
    }
    j += 1;
    while (j < source.length && /\s/.test(source[j])) {
      j += 1;
    }
    if (source[j] !== "{") {
      i = j - 1;
      continue;
    }

    const blockStart = j;
    let blockDepth = 1;
    for (let k = blockStart + 1; k < source.length; k += 1) {
      if (source[k] === "{") {
        blockDepth += 1;
      } else if (source[k] === "}") {
        blockDepth -= 1;
        if (blockDepth === 0) {
          return {
            content: source.slice(blockStart + 1, k),
            after: source.slice(k + 1),
          };
        }
      }
    }
  }

  return undefined;
};

const trySchemaObjectTypeQuery = (schema: SchemaSnapshot, query: string): QueryResult | undefined => {
  if (!/\bObjectType\b/i.test(query)) {
    return undefined;
  }

  const looksLikeSchemaModule = /\bWITH\s+MODULE\s+schema\b/i.test(query) || /\bschema::ObjectType\b/i.test(query);
  if (!looksLikeSchemaModule) {
    return undefined;
  }

  const shape = extractObjectTypeShape(query);
  if (!shape) {
    return undefined;
  }

  const typeAnnotationsBlock = extractTopLevelBlock(shape, "annotations");
  const propertiesBlock = extractTopLevelBlock(shape, "properties");
  const linksBlock = extractTopLevelBlock(shape, "links");

  const propertyAnnotationsBlock = propertiesBlock ? extractTopLevelBlock(propertiesBlock.content, "annotations") : undefined;
  const constraintsBlock = propertiesBlock ? extractTopLevelBlock(propertiesBlock.content, "constraints") : undefined;
  const constraintAnnotationsBlock = constraintsBlock ? extractTopLevelBlock(constraintsBlock.content, "annotations") : undefined;

  const linkAnnotationsBlock = linksBlock ? extractTopLevelBlock(linksBlock.content, "annotations") : undefined;
  const linkPropertiesBlock = linksBlock ? extractTopLevelBlock(linksBlock.content, "properties") : undefined;
  const linkPropertyAnnotationsBlock = linkPropertiesBlock
    ? extractTopLevelBlock(linkPropertiesBlock.content, "annotations")
    : undefined;

  const includeTypeAnnotations = !!typeAnnotationsBlock;
  const includeProperties = !!propertiesBlock;
  const includePropertyAnnotations = !!propertyAnnotationsBlock;
  const includeConstraints = !!constraintsBlock;
  const includeConstraintAnnotations = !!constraintAnnotationsBlock;
  const includeLinks = !!linksBlock;
  const includeLinkAnnotations = !!linkAnnotationsBlock;
  const includeLinkProperties = !!linkPropertiesBlock;
  const includeLinkPropertyAnnotations = !!linkPropertyAnnotationsBlock;

  const includeAnnotationValue = /@value/i.test(query);
  const filterExistsAnnotations = /FILTER[\s\S]*EXISTS\s+\.annotations/i.test(query);
  const filterExistsPointersAnnotations = /EXISTS\s+\.pointers\.annotations/i.test(query);
  const typeOrderByName = /ORDER\s+BY\s+\.name/i.test(query);
  const typeAnnotationOrderByName = typeAnnotationsBlock ? /ORDER\s+BY\s+\.name/i.test(typeAnnotationsBlock.after) : false;
  const filterObjectPropertiesExistsAnnotations = propertiesBlock
    ? /FILTER\s+EXISTS\s+\.annotations/i.test(propertiesBlock.after)
    : false;
  const propertiesOrderByName = propertiesBlock ? /ORDER\s+BY\s+\.name/i.test(propertiesBlock.after) : false;
  const filterObjectLinksExistsAnnotations = linksBlock
    ? /FILTER\s+EXISTS\s+\.annotations/i.test(linksBlock.after)
    : false;
  const linksOrderByName = linksBlock ? /ORDER\s+BY\s+\.name/i.test(linksBlock.after) : false;
  const filterLinksHavingTitleOnLinkProperties = linksBlock
    ? /'std::title'\s+IN\s+\.properties\.annotations\.name/i.test(linksBlock.after)
    : false;
  const filterLinkPropertiesExistsAnnotations = linkPropertiesBlock
    ? /FILTER\s+EXISTS\s+\.annotations/i.test(linkPropertiesBlock.after)
    : false;
  const linkPropertiesOrderByName = linkPropertiesBlock
    ? /ORDER\s+BY\s+\.name/i.test(linkPropertiesBlock.after)
    : false;

  const likeMatch = query.match(/\.name\s+LIKE\s+'([^']+)'/i);
  const likePattern = likeMatch?.[1];
  const equalsMatch = query.match(/\.name\s*=\s*'([^']+)'/i);
  const equalsName = equalsMatch?.[1];

  const rows = schema.listTypes().map((typeDef) => {
    const introspectionType = buildIntrospectionType(typeDef);
    const row: Record<string, unknown> = {
      name: introspectionType.name,
    };

    if (includeTypeAnnotations) {
      const annotations = introspectionType.annotations.map((annotation) => ({
        name: annotation.name,
        ...(includeAnnotationValue ? { "@value": annotation["@value"] } : {}),
      }));
      if (typeAnnotationOrderByName) {
        annotations.sort((a, b) => a.name.localeCompare(b.name));
      }
      row.annotations = annotations;
    }

    if (includeProperties) {
      let properties = introspectionType.properties.slice();
      if (filterObjectPropertiesExistsAnnotations) {
        properties = properties.filter((property) => property.annotations.length > 0);
      }
      if (propertiesOrderByName) {
        properties.sort((a, b) => a.name.localeCompare(b.name));
      }

      row.properties = properties.map((property) => {
        const out: Record<string, unknown> = { name: property.name };
        if (includePropertyAnnotations) {
          out.annotations = property.annotations.map((annotation) => ({
            name: annotation.name,
            ...(includeAnnotationValue ? { "@value": annotation["@value"] } : {}),
          }));
        }
        if (includeConstraints) {
          out.constraints = property.constraints.map((constraint) => ({
            ...(includeConstraintAnnotations
              ? {
                  annotations: constraint.annotations.map((annotation) => ({
                    name: annotation.name,
                    ...(includeAnnotationValue ? { "@value": annotation["@value"] } : {}),
                  })),
                }
              : {}),
          }));
        }
        return out;
      });
    }

    if (includeLinks) {
      let links = introspectionType.links.slice();
      if (filterObjectLinksExistsAnnotations) {
        links = links.filter((link) => link.annotations.length > 0);
      }

      let projectedLinks = links.map((link) => {
        const out: Record<string, unknown> = { name: link.name };
        if (includeLinkAnnotations) {
          out.annotations = link.annotations.map((annotation) => ({
            name: annotation.name,
            ...(includeAnnotationValue ? { "@value": annotation["@value"] } : {}),
          }));
        }

        if (includeLinkProperties) {
          let linkProperties = link.properties.slice();
          if (filterLinkPropertiesExistsAnnotations) {
            linkProperties = linkProperties.filter((property) => property.annotations.length > 0);
          }
          if (linkPropertiesOrderByName) {
            linkProperties.sort((a, b) => a.name.localeCompare(b.name));
          }
          out.properties = linkProperties.map((property) => ({
            name: property.name,
            ...(includeLinkPropertyAnnotations
              ? {
                  annotations: property.annotations.map((annotation) => ({
                    name: annotation.name,
                    ...(includeAnnotationValue ? { "@value": annotation["@value"] } : {}),
                  })),
                }
              : {}),
          }));
        }

        return out;
      });

      if (filterLinksHavingTitleOnLinkProperties) {
        projectedLinks = projectedLinks.filter((link) => {
          const properties = (link.properties as Array<{ annotations?: Array<{ name: string }> }> | undefined) ?? [];
          return properties.some((property) =>
            (property.annotations ?? []).some((annotation) => annotation.name === "std::title"));
        });
      }

      if (linksOrderByName) {
        projectedLinks.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      }

      row.links = projectedLinks;
    }

    return { row, introspectionType };
  });

  const filtered = rows.filter(({ row, introspectionType }) => {
    if (filterExistsAnnotations) {
      if (introspectionType.annotations.length === 0) {
        return false;
      }
    }

    if (filterExistsPointersAnnotations) {
      if (!introspectionType.pointersHaveAnnotations) {
        return false;
      }
    }

    if (likePattern) {
      if (likePattern.endsWith("%")) {
        const prefix = likePattern.slice(0, -1);
        return row.name.startsWith(prefix);
      }
      return row.name === likePattern;
    }

    if (equalsName && row.name !== equalsName) {
      return false;
    }

    return true;
  });

  if (typeOrderByName) {
    filtered.sort((a, b) => String(a.row.name).localeCompare(String(b.row.name)));
  }

  return {
    kind: "select",
    rows: filtered.map((entry) => entry.row),
  };
};

export const executeQuery = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  query: string,
  securityContext: SecurityContext = DEFAULT_SECURITY_CONTEXT,
): QueryResult => {
  const schemaQueryResult = trySchemaObjectTypeQuery(schema, query);
  if (schemaQueryResult) {
    return schemaQueryResult;
  }
  return executeQueryWithTrace(db, schema, query, securityContext).result;
};

export const executeScript = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  script: string,
  securityContext: SecurityContext = DEFAULT_SECURITY_CONTEXT,
): QueryResult => {
  return executeQueryUnitWithTrace(db, schema, script, securityContext).result;
};

export const executeQueryWithTrace = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  query: string,
  securityContext: SecurityContext = DEFAULT_SECURITY_CONTEXT,
): QueryExecutionTrace => {
  try {
    const context = normalizeSecurityContext(securityContext);
    const runtimeTarget = resolvedRuntimeTarget(context, db);
    const compilerService = getCompilerService();
    const ast = parseEdgeQL(query);
    const statementType = statementTypeOf(ast);
    enforceBuiltinPermissions(context, statementType, ast.pos.line, ast.pos.column);
    const subjectType = ast.kind === "insert" || ast.kind === "update" || ast.kind === "delete"
      ? schema.getType(ast.typeName)
      : undefined;
    if ((ast.kind === "insert" || ast.kind === "update" || ast.kind === "delete") && !subjectType) {
      throw new AppError("E_SEMANTIC", `Unknown type '${ast.typeName}'`, ast.pos.line, ast.pos.column);
    }
    const compiled = compilerService.compile(schema, ast, { globals: context.globals, target: runtimeTarget });
    const ir = compiled.ir;
    const sqlArtifact = compiled.sql;
    assertTargetSqlCompatibility(sqlArtifact.sql, runtimeTarget);
    const sqlTrail: SQLArtifact[] = [sqlArtifact];

    let result: QueryResult;
    if (ir.kind === "select") {
      result = {
        kind: "select",
        rows: runSelectIR(db, schema, ir, context, sqlArtifact, sqlTrail),
      };
    } else if (ir.kind === "select_free") {
      result = {
        kind: "select",
        rows: [materializeFreeObjectRow(db, schema, ir.entries, context, sqlTrail)],
      };
    } else {
      const writeResult = runWriteWithAccessPolicies(db, schema, ast, ir, sqlArtifact, subjectType!, context);

      result = {
        kind: ir.kind,
        changes: writeResult.changes,
      };
    }

    return {
      ast,
      ir,
      sql: sqlArtifact,
      compiler: compiled.cache,
      sqlTrail,
      overlays: extractOverlays(ir),
      result,
    };
  } catch (err) {
    throw asAppError(err);
  }
};

export const executeQueryUnitWithTrace = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  script: string,
  securityContext: SecurityContext = DEFAULT_SECURITY_CONTEXT,
): QueryUnitTrace => {
  try {
    const context = normalizeSecurityContext(securityContext);
    const runtimeTarget = resolvedRuntimeTarget(context, db);
    const compilerService = getCompilerService();
    const statements = parseEdgeQLScript(script);
    if (statements.length === 0) {
      throw new Error("No statements to execute");
    }

    const overlays: OverlayIR[] = [];
    const traces: QueryExecutionTrace[] = [];

    for (const ast of statements) {
      const statementType = statementTypeOf(ast);
      enforceBuiltinPermissions(context, statementType, ast.pos.line, ast.pos.column);
      const subjectType = ast.kind === "insert" || ast.kind === "update" || ast.kind === "delete"
        ? schema.getType(ast.typeName)
        : undefined;
      if ((ast.kind === "insert" || ast.kind === "update" || ast.kind === "delete") && !subjectType) {
        throw new AppError("E_SEMANTIC", `Unknown type '${ast.typeName}'`, ast.pos.line, ast.pos.column);
      }

      const compiled = compilerService.compile(schema, ast, { overlays, globals: context.globals, target: runtimeTarget });
      const ir = compiled.ir;
      const sqlArtifact = compiled.sql;
      assertTargetSqlCompatibility(sqlArtifact.sql, runtimeTarget);
      const sqlTrail: SQLArtifact[] = [sqlArtifact];

      let result: QueryResult;
      if (ir.kind === "select") {
        result = { kind: "select", rows: runSelectIR(db, schema, ir, context, sqlArtifact, sqlTrail) };
      } else if (ir.kind === "select_free") {
        result = { kind: "select", rows: [materializeFreeObjectRow(db, schema, ir.entries, context, sqlTrail)] };
      } else {
        const writeResult = runWriteWithAccessPolicies(db, schema, ast, ir, sqlArtifact, subjectType!, context);
        result = { kind: ir.kind, changes: writeResult.changes };
      }

      const currentOverlays = extractOverlays(ir);
      if (ir.kind !== "select" && ir.kind !== "select_free") {
        overlays.push(...currentOverlays);
      }

      traces.push({
        ast,
        ir,
        sql: sqlArtifact,
        compiler: compiled.cache,
        sqlTrail,
        overlays: currentOverlays,
        result,
      });
    }

    return {
      traces,
      result: traces[traces.length - 1].result,
    };
  } catch (err) {
    throw asAppError(err);
  }
};

const materializeSelectRow = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  context: SecurityContext,
  shape: SelectShapeElementIR[],
  row: Record<string, unknown>,
  sourceType: string,
  sqlTrail: SQLArtifact[],
): Record<string, unknown> => {
  const output: Record<string, unknown> = {};

  for (const element of shape) {
    if (element.kind === "field") {
      output[element.name] = materializeFieldValue(schema, sourceType, element.column, row[element.column]);
      continue;
    }

    if (element.kind === "computed") {
      if (element.expr.kind === "field_ref") {
        output[element.name] = materializeFieldValue(schema, sourceType, element.expr.column, row[element.expr.column]);
      } else if (element.expr.kind === "literal") {
        output[element.name] = element.expr.value;
      } else if (element.expr.kind === "polymorphic_field_ref") {
        output[element.name] = element.expr.sourceType === sourceType
          ? materializeFieldValue(schema, sourceType, element.expr.column, row[element.expr.column])
          : [];
      } else if (element.expr.kind === "subquery") {
        const nestedSql = compileToSQL(element.expr.query, { target: resolvedRuntimeTarget(context, db) });
        assertTargetSqlCompatibility(nestedSql.sql, resolvedRuntimeTarget(context, db));
        sqlTrail.push(nestedSql);
        output[element.name] = runSelectIR(db, schema, element.expr.query, context, nestedSql, sqlTrail);
      } else if (element.expr.kind === "concat") {
        output[element.name] = element.expr.parts
          .map((part) => (part.kind === "field_ref" ? row[part.column] : part.value))
          .map((value) => (value === null || value === undefined ? "" : String(value)))
          .join("");
      } else if (element.expr.kind === "function_call") {
        const loweredAlias = computedValueAlias(element.pathId);
        if (Object.prototype.hasOwnProperty.call(row, loweredAlias)) {
          output[element.name] = row[loweredAlias];
          continue;
        }

        const args: RuntimeFunctionArg[] = element.expr.args.map((arg) => {
          if (arg.kind === "field_ref") {
            return row[arg.column] as ScalarValue;
          }

          if (arg.kind === "function_call") {
            return executeFunctionCall(schema, db, context, arg.functionName, arg.args.map((nested) => {
              if (nested.kind === "field_ref") {
                return row[nested.column] as ScalarValue;
              }
              if (nested.kind === "set_literal") {
                return { kind: "set" as const, values: [...nested.values] };
              }
              if (nested.kind === "array_literal") {
                return { kind: "array" as const, values: [...nested.values] };
              }
              return nested.value;
            })) as RuntimeFunctionArg;
          }

          if (arg.kind === "set_literal") {
            return { kind: "set" as const, values: [...arg.values] };
          }

          if (arg.kind === "array_literal") {
            return { kind: "array" as const, values: [...arg.values] };
          }

          return arg.value;
        });
        output[element.name] = executeFunctionCall(schema, db, context, element.expr.functionName, args);
      } else {
        output[element.name] = { name: sourceType };
      }
      continue;
    }

    if (element.kind === "link") {
      if (element.sourceTypeFilter && element.sourceTypeFilter !== sourceType) {
        output[element.name] = [];
        continue;
      }

      const payload = parsePayloadArray(row[shapePayloadAlias(element.pathId)]);
      if (payload) {
        output[element.name] = payload;
        continue;
      }

      output[element.name] = resolveLinks(db, schema, context, row, element.relation, element.typeFilter, {
        columns: element.columns,
        shape: element.shape,
        filter: element.filter,
        orderBy: element.orderBy,
        limit: element.limit,
        offset: element.offset,
      }, sqlTrail);
      continue;
    }

    const payload = parsePayloadArray(row[shapePayloadAlias(element.pathId)]);
    if (payload) {
      output[element.name] = payload;
      continue;
    }

    const targetId = row.id;
    output[element.name] = isScalarValue(targetId) ? resolveBacklinks(db, element.sources, targetId, sqlTrail) : [];
  }

  return output;
};

const materializeFieldValue = (
  schema: SchemaSnapshot,
  sourceType: string,
  fieldName: string,
  value: unknown,
): unknown => {
  const field = findFieldDef(schema, sourceType, fieldName);
  if (!field) {
    return value;
  }

  if (field.multi) {
    if (value === null || value === undefined) {
      return [];
    }
    if (typeof value !== "string") {
      return [];
    }

    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.map((item) => coerceScalarForOutput(field.type, item));
    } catch {
      return [];
    }
  }

  return coerceScalarForOutput(field.type, value);
};

const findFieldDef = (schema: SchemaSnapshot, typeName: string, fieldName: string, seen = new Set<string>()) => {
  if (seen.has(typeName)) {
    return undefined;
  }
  seen.add(typeName);

  const typeDef = schema.getType(typeName);
  if (!typeDef) {
    return undefined;
  }

  const direct = typeDef.fields.find((field) => field.name === fieldName);
  if (direct) {
    return direct;
  }

  for (const baseName of typeDef.extends ?? []) {
    const inherited = findFieldDef(schema, baseName, fieldName, seen);
    if (inherited) {
      return inherited;
    }
  }

  return undefined;
};

const coerceScalarForOutput = (type: ScalarType, value: unknown): unknown => {
  if (value === null || value === undefined) {
    return null;
  }

  if (type === "json" && typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  if (type === "bool") {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value !== 0;
    }
    if (typeof value === "string") {
      if (value === "1" || value.toLowerCase() === "true") {
        return true;
      }
      if (value === "0" || value.toLowerCase() === "false") {
        return false;
      }
    }
  }

  return value;
};

const runSelectIR = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ir: SelectIR,
  context: SecurityContext,
  sqlArtifact: SQLArtifact,
  sqlTrail: SQLArtifact[],
): Record<string, unknown>[] => {
  const subjectType = schema.getType(ir.sourceType);
  if (!subjectType) {
    throw new AppError("E_SEMANTIC", `Unknown type '${ir.sourceType}'`, 1, 1);
  }

  const stmt = db.prepare(sqlArtifact.sql);
  const rows = stmt.all(...sqlArtifact.params);
  const visibleRows = rows.filter((row) => evaluateSelectPolicies(schema, db, subjectType, row, context));
  return visibleRows.map((row) => materializeSelectRow(db, schema, context, ir.shape, row, rowSourceType(row, ir.sourceType), sqlTrail));
};

const materializeFreeObjectRow = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  entries: Extract<IRStatement, { kind: "select_free" }>["entries"],
  context: SecurityContext,
  sqlTrail: SQLArtifact[],
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};

  for (const entry of entries) {
    if (entry.kind === "literal") {
      out[entry.name] = entry.value;
      continue;
    }

    if (entry.kind === "set_literal") {
      out[entry.name] = [...entry.values];
      continue;
    }

    if (entry.kind === "function_call") {
      out[entry.name] = executeFunctionCall(
        schema,
        db,
        context,
        entry.functionName,
        entry.args.map((arg): RuntimeFunctionArg => {
          if (arg.kind === "function_call") {
            return executeFunctionCall(
              schema,
              db,
              context,
              arg.functionName,
              arg.args.map((nested) => {
                if (nested.kind === "binding_ref") {
                  return context.globals?.[nested.name] ?? null;
                }
                if (nested.kind === "set_literal") {
                  return { kind: "set" as const, values: [...nested.values] };
                }
                if (nested.kind === "array_literal") {
                  return { kind: "array" as const, values: [...nested.values] };
                }
                return nested.value;
              }),
            ) as RuntimeFunctionArg;
          }

          if (arg.kind === "set_literal") {
            return { kind: "set" as const, values: [...arg.values] };
          }

          if (arg.kind === "array_literal") {
            return { kind: "array" as const, values: [...arg.values] };
          }

          if (arg.kind === "binding_ref") {
            return context.globals?.[arg.name] ?? null;
          }

          return arg.value;
        }),
      );
      continue;
    }

    const nestedSql = compileToSQL(entry.query, { target: resolvedRuntimeTarget(context, db) });
    assertTargetSqlCompatibility(nestedSql.sql, resolvedRuntimeTarget(context, db));
    sqlTrail.push(nestedSql);
    out[entry.name] = runSelectIR(db, schema, entry.query, context, nestedSql, sqlTrail);
  }

  return out;
};

const executeFunctionCall = (
  schema: SchemaSnapshot,
  db: SQLiteDatabase,
  context: SecurityContext,
  qualifiedName: string,
  args: RuntimeFunctionArg[],
): unknown => {
  const builtin = resolveStdlibFunction(qualifiedName, args.length);
  if (builtin) {
    return executeStdlibFunction(qualifiedName, args);
  }

  const divider = qualifiedName.lastIndexOf("::");
  const moduleName = divider >= 0 ? qualifiedName.slice(0, divider) : "default";
  const fnName = divider >= 0 ? qualifiedName.slice(divider + 2) : qualifiedName;
  const fn = schema.findFunction(moduleName, fnName, args.length);
  if (!fn) {
    throw new AppError("E_SEMANTIC", `Unknown function '${qualifiedName}'`, 1, 1);
  }

  const bindings = bindFunctionArgs(fn, args);
  if (fn.volatility === "Modifying") {
    for (const param of fn.params) {
      const value = bindings.get(param.name);
      if (value === undefined || value === null) {
        if (!param.optional) {
          throw new AppError(
            "E_SEMANTIC",
            "possibly an empty set passed as non-optional argument into modifying function",
            1,
            1,
          );
        }
        continue;
      }

      if (Array.isArray(value)) {
        if (value.length === 0) {
          if (!param.optional) {
            throw new AppError(
                "E_SEMANTIC",
              "possibly an empty set passed as non-optional argument into modifying function",
              1,
              1,
            );
          }
          continue;
        }

        if (value.length === 1) {
          continue;
        }
        throw new AppError("E_SEMANTIC", "possibly more than one element passed into modifying function", 1, 1);
      }
    }
  }

  if (fn.body.kind === "expr") {
    return evaluateExprBody(fn, bindings);
  }

  const withPrefix = fn.params
    .map((param) => `${param.name} := ${literalToEdgeQL(bindings.get(param.name) ?? null)}`)
    .join(", ");
  const query = withPrefix.length > 0 ? `with ${withPrefix} ${fn.body.query}` : fn.body.query;
  const result = executeQuery(db, schema, query, context);
  if (result.rows) {
    if (result.rows.length === 1 && Object.keys(result.rows[0] ?? {}).length === 1) {
      return Object.values(result.rows[0])[0];
    }
    return result.rows;
  }
  return result.changes ?? 0;
};

const bindFunctionArgs = (fn: FunctionDef, args: RuntimeFunctionArg[]): Map<string, ScalarValue | ScalarValue[] | null> => {
  const out = new Map<string, ScalarValue | ScalarValue[] | null>();
  let cursor = 0;
  for (const param of fn.params) {
    if (param.variadic) {
      const variadicValues: ScalarValue[] = [];
      while (cursor < args.length) {
        const next = args[cursor];
        cursor += 1;
        if (typeof next === "object" && next !== null && "kind" in next && next.kind === "array") {
          variadicValues.push(...next.values);
        } else if (typeof next === "object" && next !== null && "kind" in next && next.kind === "set") {
          variadicValues.push(...next.values);
        } else {
          variadicValues.push(next as ScalarValue);
        }
      }
      out.set(param.name, variadicValues);
      continue;
    }

    const raw = cursor < args.length ? args[cursor] : undefined;
    if (raw !== undefined) {
      cursor += 1;
    }

    if (raw === undefined) {
      if (param.default !== undefined) {
        out.set(param.name, param.default);
        continue;
      }
      if (param.optional) {
        out.set(param.name, null);
        continue;
      }
      throw new AppError("E_SEMANTIC", `Missing required function argument '${param.name}'`, 1, 1);
    }

    if (typeof raw === "object" && raw !== null && "kind" in raw) {
      if (raw.kind === "array") {
        out.set(param.name, raw.values);
      } else {
        out.set(param.name, raw.values);
      }
      continue;
    }

    out.set(param.name, raw);
  }

  return out;
};

const evaluateExprBody = (
  fn: FunctionDef,
  bindings: Map<string, ScalarValue | ScalarValue[] | null>,
): ScalarValue | ScalarValue[] => {
  if (fn.body.kind !== "expr") {
    return null;
  }

  return evaluateFunctionExpr(fn.body.expr, bindings);
};

const evaluateFunctionExpr = (
  expr: FunctionExprDef,
  bindings: Map<string, ScalarValue | ScalarValue[] | null>,
): ScalarValue | ScalarValue[] => {
  if (expr.kind === "param_ref") {
    return (bindings.get(expr.name) ?? null) as ScalarValue | ScalarValue[];
  }

  if (expr.kind === "literal") {
    return expr.value;
  }

  const evaluatedParts = expr.parts.map((part) => {
    if (part.kind === "param_ref") {
      return bindings.get(part.name) ?? null;
    }
    return part.value;
  });

  const maxLen = evaluatedParts.reduce<number>((acc, part) => (Array.isArray(part) ? Math.max(acc, part.length) : acc), 1);
  if (maxLen <= 1) {
    return evaluatedParts
      .map((part) => (Array.isArray(part) ? part[0] : part))
      .map((value) => (value === null || value === undefined ? "" : String(value)))
      .join("");
  }

  return Array.from({ length: maxLen }).map((_, index) =>
    evaluatedParts
      .map((part) => (Array.isArray(part) ? part[index] : part))
      .map((value) => (value === null || value === undefined ? "" : String(value)))
      .join(""),
  );
};

const literalToEdgeQL = (value: ScalarValue | ScalarValue[] | null): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => literalToEdgeQL(item)).join(", ")}]`;
  }

  if (value === null || value === undefined) {
    return "<str>{}";
  }

  if (typeof value === "string") {
    return `'${value.replaceAll("'", "\\'")}'`;
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return String(value);
};

const resolveLinks = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  context: SecurityContext,
  row: Record<string, unknown>,
  relation: LinkRelationIR,
  typeFilter: string | undefined,
  nested: {
    columns: string[];
    shape: SelectShapeElementIR[];
    filter?: FilterExprIR;
    orderBy?: { column: string; direction: "asc" | "desc" };
    limit?: number;
    offset?: number;
  },
  sqlTrail: SQLArtifact[],
): Record<string, unknown>[] => {
  const params: ScalarValue[] = [];
  const targetSource = compilePolymorphicTargetSource(relation, "t");
  let sql: string;

  if (relation.storage === "inline") {
    const targetId = row[relation.inlineColumn!];
    if (!isScalarValue(targetId) || targetId === null) {
      return [];
    }

    sql = `SELECT t.${quoteIdent("__source_type")} AS ${quoteIdent("__source_type")}, ${nested.columns.map((column) => `t.${quoteIdent(column)} AS ${quoteIdent(column)}`).join(", ")} FROM ${targetSource} WHERE t.${quoteIdent("id")} = ?`;
    params.push(targetId);
  } else {
    const sourceId = row.id;
    if (!isScalarValue(sourceId) || sourceId === null) {
      return [];
    }

    const tableColumns = nested.columns.map((column) => `t.${quoteIdent(column)} AS ${quoteIdent(column)}`).join(", ");
    sql = `SELECT t.${quoteIdent("__source_type")} AS ${quoteIdent("__source_type")}, ${tableColumns} FROM ${targetSource} JOIN ${quoteIdent(relation.linkTable!)} l ON l.${quoteIdent("target")} = t.${quoteIdent("id")} WHERE l.${quoteIdent("source")} = ?`;
    params.push(sourceId);
  }

  if (nested.filter) {
    sql += ` AND ${compileNestedFilterExprSQL(nested.filter, params)}`;
  }

  if (nested.orderBy) {
    sql += ` ORDER BY ${quoteIdent(nested.orderBy.column)} ${nested.orderBy.direction.toUpperCase()}`;
  }

  if (nested.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(nested.limit);
  }

  if (nested.offset !== undefined) {
    sql += " OFFSET ?";
    params.push(nested.offset);
  }

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  sqlTrail.push({ sql, params: [...params], loweringMode: "fallback_multi_query" });
  return rows.map((item) => materializeSelectRow(db, schema, context, nested.shape, item, rowSourceType(item, relation.targetType), sqlTrail));
};

const resolveBacklinks = (
  db: SQLiteDatabase,
  sources: BacklinkSourceIR[],
  targetId: ScalarValue,
  sqlTrail: SQLArtifact[],
): Array<{ id: unknown; __type__: string }> => {
  const seen = new Set<string>();
  const out: Array<{ id: unknown; __type__: string }> = [];

  for (const source of sources) {
    let rows: Array<{ id: unknown }> = [];
    if (source.storage === "inline") {
      const sql = `SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(source.table)} WHERE ${quoteIdent(source.inlineColumn!)} = ?`;
      sqlTrail.push({ sql, params: [targetId], loweringMode: "fallback_multi_query" });
      rows = db.prepare(sql).all(targetId) as Array<{ id: unknown }>;
    } else {
      const sql = `SELECT s.${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(source.table)} s JOIN ${quoteIdent(source.linkTable!)} l ON l.${quoteIdent("source")} = s.${quoteIdent("id")} WHERE l.${quoteIdent("target")} = ?`;
      sqlTrail.push({ sql, params: [targetId], loweringMode: "fallback_multi_query" });
      rows = db.prepare(sql).all(targetId) as Array<{ id: unknown }>;
    }

    for (const row of rows) {
      const key = `${source.sourceType}:${String(row.id)}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      out.push({
        id: row.id,
        __type__: source.sourceType,
      });
    }
  }

  return out;
};

const quoteIdent = (ident: string): string => `"${ident.replaceAll('"', '""')}"`;

const compileFilterPredicate = (lhsSql: string, op: "=" | "!=" | "like" | "ilike"): string => {
  if (op === "=") {
    return `${lhsSql} = ?`;
  }

  if (op === "!=") {
    return `${lhsSql} != ?`;
  }

  if (op === "like") {
    return `${lhsSql} LIKE ?`;
  }

  return `LOWER(${lhsSql}) LIKE LOWER(?)`;
};

const compileNestedFilterExprSQL = (filter: FilterExprIR, params: ScalarValue[]): string => {
  if (filter.kind === "field") {
    params.push(filter.value);
    return compileFilterPredicate(`t.${quoteIdent(filter.column)}`, filter.op);
  }

  if (filter.kind === "backlink") {
    throw new AppError("E_SQL", "Backlink filters are not supported for nested runtime link resolution");
  }

  if (filter.kind === "not") {
    return `(NOT ${compileNestedFilterExprSQL(filter.expr, params)})`;
  }

  const left = compileNestedFilterExprSQL(filter.left, params);
  const right = compileNestedFilterExprSQL(filter.right, params);
  return filter.kind === "and" ? `(${left} AND ${right})` : `(${left} OR ${right})`;
};

const compilePolymorphicTargetSource = (relation: LinkRelationIR, alias: string): string => {
  const targets = relation.targetTables.length > 0
    ? relation.targetTables
    : [{ name: relation.targetType, table: relation.targetTable }];

  if (targets.length === 1) {
    const only = targets[0];
    return `(SELECT '${only.name.replaceAll("'", "''")}' AS ${quoteIdent("__source_type")}, * FROM ${quoteIdent(only.table)}) ${alias}`;
  }

  const selects = targets.map(
    (target) => `SELECT '${target.name.replaceAll("'", "''")}' AS ${quoteIdent("__source_type")}, * FROM ${quoteIdent(target.table)}`,
  );
  return `(${selects.join(" UNION ALL ")}) ${alias}`;
};

const isScalarValue = (value: unknown): value is ScalarValue =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const parsePayloadArray = (value: unknown): unknown[] | null => {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return null;
  }
};

const rowSourceType = (row: Record<string, unknown>, fallbackType: string): string => {
  const type = row.__source_type;
  return typeof type === "string" ? type : fallbackType;
};

const extractOverlays = (ir: IRStatement): OverlayIR[] => {
  if (ir.kind === "select") {
    return ir.appliedOverlays;
  }

  if (ir.kind === "select_free") {
    return [];
  }

  return ir.overlays;
};

const tableNameForType = (qualifiedName: string): string => qualifiedName.replaceAll("::", "__").toLowerCase();

const validateLinkAssignments = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ir: IRStatement,
  ast: Statement,
): void => {
  if (ir.kind !== "insert" && ir.kind !== "update") {
    return;
  }

  const typeDef = schema.listTypes().find((candidate) => tableNameForType(qualifiedTypeName(candidate)) === ir.table);
  if (!typeDef) {
    return;
  }

  for (const link of typeDef.links ?? []) {
    if (link.multi) {
      continue;
    }

    const inlineColumn = `${link.name}_id`;
    if (!(inlineColumn in ir.values)) {
      continue;
    }

    const assignedId = ir.values[inlineColumn];
    if (assignedId === null) {
      continue;
    }
    if (typeof assignedId !== "string") {
      throw new AppError("E_SEMANTIC", `Invalid id for link '${link.name}': expected string`, ast.pos.line, ast.pos.column);
    }

    const row = db
      .prepare('SELECT "type_name" AS "type_name" FROM "__gel_global_ids" WHERE "id" = ?')
      .all(assignedId)[0] as { type_name?: unknown } | undefined;

    if (!row || typeof row.type_name !== "string") {
      throw new AppError(
        "E_SEMANTIC",
        `Invalid id for link '${link.name}': '${assignedId}' does not reference an existing object`,
        ast.pos.line,
        ast.pos.column,
      );
    }

    const expectedTargetTable = tableNameForType(link.targetType.includes("::") ? link.targetType : `${typeDef.module ?? "default"}::${link.targetType}`);
    if (row.type_name !== expectedTargetTable) {
      throw new AppError(
        "E_SEMANTIC",
        `Invalid id for link '${link.name}': expected '${expectedTargetTable}', got '${row.type_name}'`,
        ast.pos.line,
        ast.pos.column,
      );
    }
  }
};

const fieldsFromShape = (shape: SelectStatement["shape"]): string[] => {
  const fields = new Set<string>(["id"]);
  for (const element of shape) {
    if (element.kind === "field") {
      fields.add(element.name);
    }
  }
  return [...fields];
};

const typeDefForInsertIR = (schema: SchemaSnapshot, table: string): TypeDef | undefined =>
  schema.listTypes().find((candidate) => tableNameForType(qualifiedTypeName(candidate)) === table);

const resolveConflictField = (ast: InsertStatement, typeDef: TypeDef): string | undefined => {
  if (ast.conflict?.onField) {
    return ast.conflict.onField;
  }

  for (const candidate of ["name", "title"]) {
    if (typeDef.fields.some((field) => field.name === candidate) && candidate in ast.values) {
      return candidate;
    }
  }

  return undefined;
};

const scalarFromInsertValue = (
  value: InsertValue,
  resolveBinding: (name: string) => ScalarValue,
  line: number,
  column: number,
): ScalarValue => {
  if (isScalarValue(value)) {
    return value;
  }

  if (value.kind === "binding_ref") {
    return resolveBinding(value.name);
  }

  throw new AppError("E_SEMANTIC", `Expected scalar value, got '${value.kind}'`, line, column);
};

const findConflictRowId = (
  db: SQLiteDatabase,
  table: string,
  field: string,
  value: ScalarValue,
): string | undefined => {
  const row = db
    .prepare(`SELECT "id" AS "id" FROM ${quoteIdent(table)} WHERE ${quoteIdent(field)} = ? LIMIT 1`)
    .all(value)[0] as { id?: unknown } | undefined;
  return typeof row?.id === "string" ? row.id : undefined;
};

const makeBindingResolver = (
  ast: Statement,
  context: SecurityContext,
  line: number,
  column: number,
): ((name: string) => ScalarValue) => {
  const bindings = new Map((ast.with ?? []).map((binding) => [binding.name, binding.value] as const));
  const cache = new Map<string, ScalarValue>();
  const pending = new Set<string>();

  const resolve = (name: string): ScalarValue => {
    if (cache.has(name)) {
      return cache.get(name) as ScalarValue;
    }
    if (pending.has(name)) {
      throw new AppError("E_SEMANTIC", `Cyclic with binding '${name}'`, line, column);
    }

    const binding = bindings.get(name);
    if (!binding) {
      throw new AppError("E_SEMANTIC", `Unknown with binding '${name}'`, line, column);
    }

    pending.add(name);
    let value: ScalarValue;
    if (binding.kind === "literal") {
      value = binding.value;
    } else if (binding.kind === "binding_ref") {
      value = resolve(binding.name);
    } else if (binding.kind === "parameter") {
      const globals = context.globals ?? {};
      if (!Object.prototype.hasOwnProperty.call(globals, binding.name)) {
        throw new AppError("E_SEMANTIC", `Unknown query parameter '$${binding.name}'`, line, column);
      }
      value = globals[binding.name] as ScalarValue;
    } else {
      throw new AppError("E_SEMANTIC", `With binding '${name}' is a subquery and cannot be scalar`, line, column);
    }

    pending.delete(name);
    cache.set(name, value);
    return value;
  };

  return resolve;
};

const executeSelectExprRows = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  expr: Extract<InsertValue, { kind: "select" }>,
  context: SecurityContext,
): Record<string, unknown>[] => {
  const ast: SelectStatement = {
    kind: "select",
    typeName: expr.typeName,
    shape: expr.shape,
    fields: fieldsFromShape(expr.shape),
    filter: expr.clauses.filter,
    orderBy: expr.clauses.orderBy,
    limit: expr.clauses.limit,
    offset: expr.clauses.offset,
    pos: { line: 1, column: 1 },
  };

  const compiler = getCompilerService();
  const compiled = compiler.compile(schema, ast, { globals: context.globals });
  assertTargetSqlCompatibility(compiled.sql.sql, resolvedRuntimeTarget(context, db));
  if (compiled.ir.kind !== "select") {
    return [];
  }
  return runSelectIR(db, schema, compiled.ir, context, compiled.sql, []);
};

const statementTypeOf = (statement: Statement): "select" | "insert" | "update" | "delete" =>
  statement.kind === "select_free" ? "select" : statement.kind;

const normalizeSecurityContext = (context: SecurityContext): SecurityContext => {
  return {
    roleName: context.roleName ?? DEFAULT_SECURITY_CONTEXT.roleName,
    isSuperuser: context.isSuperuser ?? DEFAULT_SECURITY_CONTEXT.isSuperuser,
    permissions: context.permissions ? [...context.permissions] : [...(DEFAULT_SECURITY_CONTEXT.permissions ?? [])],
    globals: { ...(DEFAULT_SECURITY_CONTEXT.globals ?? {}), ...(context.globals ?? {}) },
    runtimeTarget: context.runtimeTarget ?? DEFAULT_SECURITY_CONTEXT.runtimeTarget,
  };
};

const enforceBuiltinPermissions = (
  context: SecurityContext,
  statementType: "select" | "insert" | "update" | "delete",
  line: number,
  column: number,
): void => {
  if (context.isSuperuser) {
    return;
  }

  if (statementType === "insert" || statementType === "update" || statementType === "delete") {
    if (!hasPermission(context, "sys::perm::data_modification")) {
      throw new AppError(
        "E_RUNTIME",
        "Permission denied: 'sys::perm::data_modification' is required for data modification statements",
        line,
        column,
      );
    }
  }
};

const hasPermission = (context: SecurityContext, permissionName: string): boolean => {
  if (context.isSuperuser) {
    return true;
  }

  return new Set(context.permissions ?? []).has(permissionName);
};

const runWriteWithAccessPolicies = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: Statement,
  ir: IRStatement,
  sqlArtifact: SQLArtifact,
  subjectType: TypeDef,
  context: SecurityContext,
): { changes: number } => {
  validateLinkAssignments(db, schema, ir, ast);

  db.prepare("BEGIN").run();
  try {
    if (ir.kind === "insert") {
      enforceInsertPolicies(subjectType, ir.values, context, ast.pos.line, ast.pos.column);

      if (ast.kind === "insert" && ast.conflict) {
        const conflictField = resolveConflictField(ast, subjectType);
        if (conflictField) {
          const resolveBinding = makeBindingResolver(ast, context, ast.pos.line, ast.pos.column);
          const rawValue = ast.values[conflictField];
          if (rawValue !== undefined) {
            const conflictValue = scalarFromInsertValue(rawValue, resolveBinding, ast.pos.line, ast.pos.column);
            const existingId = findConflictRowId(db, ir.table, conflictField, conflictValue);
            if (existingId) {
              if (ast.conflict.else?.kind === "update") {
                const updates = Object.entries(ast.conflict.else.values);
                if (updates.length > 0) {
                  const sql = `UPDATE ${quoteIdent(ir.table)} SET ${updates
                    .map(([key]) => `${quoteIdent(key)} = ?`)
                    .join(", ")} WHERE ${quoteIdent("id")} = ?`;
                  const params = updates.map(([, value]) => value);
                  params.push(existingId);
                  const writeResult = db.prepare(sql).run(...params);
                  db.prepare("COMMIT").run();
                  return { changes: writeResult.changes };
                }
              }

              db.prepare("COMMIT").run();
              return { changes: 0 };
            }
          }
        }
      }

      const writeResult = db.prepare(sqlArtifact.sql).run(...sqlArtifact.params);

      if (ast.kind === "insert") {
        const inserted = db
          .prepare(`SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(ir.table)} ORDER BY rowid DESC LIMIT 1`)
          .all()[0] as { id?: unknown } | undefined;
        if (typeof inserted?.id === "string") {
          applyInsertLinkAssignments(db, schema, ast, subjectType, inserted.id, context);
        }
      }

      db.prepare("COMMIT").run();
      return { changes: writeResult.changes };
    }

    if (ir.kind === "update") {
      const preRows = readTargetRowsForFilter(db, ir.table, ir.filter);
      enforceUpdateReadPolicies(subjectType, preRows, context, ast.pos.line, ast.pos.column);
      const writeResult = db.prepare(sqlArtifact.sql).run(...sqlArtifact.params);
      const updatedRows = preRows.length > 0 ? readRowsByIds(db, ir.table, preRows.map((row) => String(row.id))) : [];
      enforceUpdateWritePolicies(subjectType, updatedRows, context, ast.pos.line, ast.pos.column);
      db.prepare("COMMIT").run();
      return { changes: writeResult.changes };
    }

    if (ir.kind === "delete") {
      const preRows = readTargetRowsForFilter(db, ir.table, ir.filter);
      enforceDeletePolicies(subjectType, preRows, context, ast.pos.line, ast.pos.column);
      const writeResult = db.prepare(sqlArtifact.sql).run(...sqlArtifact.params);
      db.prepare("COMMIT").run();
      return { changes: writeResult.changes };
    }

    const writeResult = db.prepare(sqlArtifact.sql).run(...sqlArtifact.params);
    db.prepare("COMMIT").run();
    return { changes: writeResult.changes };
  } catch (err) {
    db.prepare("ROLLBACK").run();
    throw err;
  }
};

const executeNestedInsert = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  expr: Extract<InsertValue, { kind: "insert" }>,
  context: SecurityContext,
): string[] => {
  const ast: InsertStatement = {
    kind: "insert",
    typeName: expr.typeName,
    values: expr.values,
    pos: { line: 1, column: 1 },
  };

  const compiler = getCompilerService();
  const compiled = compiler.compile(schema, ast, { globals: context.globals });
  assertTargetSqlCompatibility(compiled.sql.sql, resolvedRuntimeTarget(context, db));
  if (compiled.ir.kind !== "insert") {
    return [];
  }

  const typeDef = typeDefForInsertIR(schema, compiled.ir.table);
  if (!typeDef) {
    return [];
  }

  enforceInsertPolicies(typeDef, compiled.ir.values, context, 1, 1);
  db.prepare(compiled.sql.sql).run(...compiled.sql.params);
  const inserted = db
    .prepare(`SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(compiled.ir.table)} ORDER BY rowid DESC LIMIT 1`)
    .all()[0] as { id?: unknown } | undefined;
  if (typeof inserted?.id !== "string") {
    return [];
  }

  applyInsertLinkAssignments(db, schema, ast, typeDef, inserted.id, context);
  return [inserted.id];
};

const resolveInsertTargetIds = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  value: InsertValue,
  context: SecurityContext,
  ast: InsertStatement,
): string[] => {
  const resolveBinding = makeBindingResolver(ast, context, ast.pos.line, ast.pos.column);

  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return typeof value === "string" ? [value] : [];
  }

  if (value.kind === "binding_ref") {
    const withValue = (ast.with ?? []).find((binding) => binding.name === value.name)?.value;
    if (withValue && withValue.kind === "subquery") {
      const rows = executeSelectExprRows(db, schema, withValue.query as Extract<InsertValue, { kind: "select" }>, context);
      return rows
        .map((row) => row.id)
        .filter((id): id is string => typeof id === "string");
    }

    const scalar = resolveBinding(value.name);
    return typeof scalar === "string" ? [scalar] : [];
  }

  if (value.kind === "select") {
    const rows = executeSelectExprRows(db, schema, value, context);
    return rows
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string");
  }

  if (value.kind === "insert") {
    return executeNestedInsert(db, schema, value, context);
  }

  if (value.kind === "set") {
    return value.values.flatMap((item) => resolveInsertTargetIds(db, schema, item, context, ast));
  }

  return [];
};

const applyInsertLinkAssignments = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: InsertStatement,
  typeDef: TypeDef,
  sourceId: string,
  context: SecurityContext,
): void => {
  const linkByName = new Map((typeDef.links ?? []).map((link) => [link.name, link] as const));
  for (const [field, value] of Object.entries(ast.values)) {
    const link = linkByName.get(field);
    if (!link) {
      continue;
    }

    const targetIds = resolveInsertTargetIds(db, schema, value, context, ast);
    const targetQualified = link.targetType.includes("::") ? link.targetType : `${typeDef.module ?? "default"}::${link.targetType}`;
    const assignableTargetTables = new Set(
      schema.listConcreteTypesAssignableTo(targetQualified).map((candidate) => tableNameForType(qualifiedTypeName(candidate))),
    );
    if (assignableTargetTables.size === 0) {
      assignableTargetTables.add(tableNameForType(targetQualified));
    }
    for (const targetId of targetIds) {
      const row = db
        .prepare('SELECT "type_name" AS "type_name" FROM "__gel_global_ids" WHERE "id" = ?')
        .all(targetId)[0] as { type_name?: unknown } | undefined;
      if (!row || typeof row.type_name !== "string") {
        throw new AppError("E_SEMANTIC", `Invalid id for link '${link.name}': '${targetId}' does not reference an existing object`, ast.pos.line, ast.pos.column);
      }
      if (!assignableTargetTables.has(row.type_name)) {
        const expected = [...assignableTargetTables].sort().join(" or ");
        throw new AppError("E_SEMANTIC", `Invalid id for link '${link.name}': expected '${expected}', got '${row.type_name}'`, ast.pos.line, ast.pos.column);
      }
    }

    const usesLinkTable = Boolean(link.multi) || (link.properties?.length ?? 0) > 0;
    if (usesLinkTable) {
      const linkTable = `${tableNameForType(qualifiedTypeName(typeDef))}__${link.name.toLowerCase()}`;
      for (const targetId of targetIds) {
        db
          .prepare(`INSERT INTO ${quoteIdent(linkTable)} (${quoteIdent("source")}, ${quoteIdent("target")}) VALUES (?, ?)`)
          .run(sourceId, targetId);
      }
      continue;
    }

    const inlineColumn = `${link.name}_id`;
    const targetId = targetIds[0] ?? null;
    db.prepare(`UPDATE ${quoteIdent(tableNameForType(qualifiedTypeName(typeDef)))} SET ${quoteIdent(inlineColumn)} = ? WHERE ${quoteIdent("id")} = ?`)
      .run(targetId, sourceId);
  }
};

const evaluateSelectPolicies = (
  schema: SchemaSnapshot,
  db: SQLiteDatabase,
  typeDef: TypeDef,
  row: Record<string, unknown>,
  context: SecurityContext,
): boolean => {
  const id = row.id;
  if (typeof id !== "string") {
    return true;
  }

  const sourceType = rowSourceType(row, qualifiedTypeName(typeDef));
  const sourceTypeDef = schema.getType(sourceType) ?? typeDef;
  const sourceTable = tableNameForType(sourceType);
  const fullRow = readRowById(db, sourceTable, id);
  if (!fullRow) {
    return false;
  }

  return evaluatePoliciesForOperation(sourceTypeDef, "select", fullRow, context, { failOnDeny: false });
};

const enforceInsertPolicies = (
  typeDef: TypeDef,
  values: Record<string, ScalarValue>,
  context: SecurityContext,
  line: number,
  column: number,
): void => {
  const row: Record<string, unknown> = { ...values };
  const ok = evaluatePoliciesForOperation(typeDef, "insert", row, context, { failOnDeny: true });
  if (!ok) {
    throw new AppError("E_RUNTIME", `Access policy violation on insert of ${qualifiedTypeName(typeDef)}`, line, column);
  }
};

const enforceUpdateReadPolicies = (
  typeDef: TypeDef,
  rows: Record<string, unknown>[],
  context: SecurityContext,
  line: number,
  column: number,
): void => {
  for (const row of rows) {
    const ok = evaluatePoliciesForOperation(typeDef, "update_read", row, context, { failOnDeny: true });
    if (!ok) {
      throw new AppError("E_RUNTIME", `Access policy violation on update read of ${qualifiedTypeName(typeDef)}`, line, column);
    }
  }
};

const enforceUpdateWritePolicies = (
  typeDef: TypeDef,
  rows: Record<string, unknown>[],
  context: SecurityContext,
  line: number,
  column: number,
): void => {
  for (const row of rows) {
    const ok = evaluatePoliciesForOperation(typeDef, "update_write", row, context, { failOnDeny: true });
    if (!ok) {
      throw new AppError("E_RUNTIME", `Access policy violation on update write of ${qualifiedTypeName(typeDef)}`, line, column);
    }
  }
};

const enforceDeletePolicies = (
  typeDef: TypeDef,
  rows: Record<string, unknown>[],
  context: SecurityContext,
  line: number,
  column: number,
): void => {
  for (const row of rows) {
    const ok = evaluatePoliciesForOperation(typeDef, "delete", row, context, { failOnDeny: true });
    if (!ok) {
      throw new AppError("E_RUNTIME", `Access policy violation on delete of ${qualifiedTypeName(typeDef)}`, line, column);
    }
  }
};

const evaluatePoliciesForOperation = (
  typeDef: TypeDef,
  operation: "select" | "insert" | "update_read" | "update_write" | "delete",
  row: Record<string, unknown>,
  context: SecurityContext,
  options: { failOnDeny: boolean },
): boolean => {
  const policies = typeDef.accessPolicies ?? [];
  if (policies.length === 0 || context.isSuperuser) {
    return true;
  }

  const relevant = policies.filter((policy) => appliesToOperation(policy, operation));
  if (relevant.length === 0) {
    return false;
  }

  const allows = relevant.filter((policy) => policy.effect === "allow");
  const denies = relevant.filter((policy) => policy.effect === "deny");
  const allowed = allows.some((policy) => evaluateCondition(policy.condition, row, context));
  if (!allowed) {
    return false;
  }

  for (const deny of denies) {
    if (evaluateCondition(deny.condition, row, context)) {
      if (options.failOnDeny) {
        throw new Error(deny.errmessage ?? `Denied by policy '${deny.name}'`);
      }
      return false;
    }
  }

  return true;
};

const appliesToOperation = (
  policy: AccessPolicyDef,
  operation: "select" | "insert" | "update_read" | "update_write" | "delete",
): boolean => {
  if (policy.operations.includes("all")) {
    return true;
  }

  if (operation === "update_read" || operation === "update_write") {
    return policy.operations.includes(operation) || policy.operations.includes("all");
  }

  return policy.operations.includes(operation);
};

const evaluateCondition = (
  condition: AccessPolicyCondition,
  row: Record<string, unknown>,
  context: SecurityContext,
): boolean => {
  switch (condition.kind) {
    case "always":
      return condition.value;
    case "global": {
      const globalValue = resolveGlobalValue(context, condition.name);
      if (typeof globalValue === "boolean") {
        return globalValue;
      }
      return globalValue !== null && globalValue !== undefined;
    }
    case "field_eq_global": {
      const globalValue = resolveGlobalValue(context, condition.global);
      return row[condition.field] === globalValue;
    }
    case "field_eq_literal":
      return row[condition.field] === condition.value;
    case "and":
      return condition.clauses.every((clause) => evaluateCondition(clause, row, context));
    default:
      return false;
  }
};

const resolveGlobalValue = (context: SecurityContext, name: string): ScalarValue | undefined => {
  if ((name.startsWith("sys::perm::") || name.startsWith("cfg::perm::") || name.includes("::perm::")) && !name.startsWith("global ")) {
    return hasPermission(context, name);
  }

  if (Object.prototype.hasOwnProperty.call(context.globals ?? {}, name)) {
    return context.globals?.[name];
  }

  if (name.includes("::")) {
    const shortName = name.split("::").at(-1);
    if (shortName && Object.prototype.hasOwnProperty.call(context.globals ?? {}, shortName)) {
      return context.globals?.[shortName];
    }
  }

  if (hasPermission(context, name)) {
    return true;
  }

  return undefined;
};

const readTargetRowsForFilter = (
  db: SQLiteDatabase,
  table: string,
  filter: { column: string; value: ScalarValue } | undefined,
): Record<string, unknown>[] => {
  let sql = `SELECT * FROM ${quoteIdent(table)}`;
  const params: ScalarValue[] = [];
  if (filter) {
    sql += ` WHERE ${quoteIdent(filter.column)} = ?`;
    params.push(filter.value);
  }

  return db.prepare(sql).all(...params);
};

const readRowsByIds = (db: SQLiteDatabase, table: string, ids: string[]): Record<string, unknown>[] => {
  if (ids.length === 0) {
    return [];
  }

  const placeholders = ids.map(() => "?").join(", ");
  const sql = `SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent("id")} IN (${placeholders})`;
  return db.prepare(sql).all(...ids);
};

const readRowById = (db: SQLiteDatabase, table: string, id: string): Record<string, unknown> | null => {
  const row = db
    .prepare(`SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent("id")} = ?`)
    .all(id)[0] as Record<string, unknown> | undefined;
  return row ?? null;
};
