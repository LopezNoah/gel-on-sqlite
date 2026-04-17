import { getCompilerService, type CompilerCacheMeta } from "../compiler/service.js";
import { AppError, asAppError } from "../errors.js";
import { parseEdgeQL, parseEdgeQLScript } from "../edgeql/parser.js";
import type { ForStatement, InsertStatement, InsertValue, SelectStatement, Statement, UpdateStatement } from "../edgeql/ast.js";
import type { RuntimeDatabaseAdapter } from "./adapter.js";
import type { SchemaSnapshot } from "../schema/schema.js";
import { compileToSQL, computedValueAlias, shapePayloadAlias, type SQLArtifact } from "../sql/compiler.js";
import { executeStdlibFunction, resolveStdlibFunction, type RuntimeFunctionArg } from "../stdlib/functions.js";
import { assertTargetSqlCompatibility, type RuntimeTarget } from "./target.js";
import type { BacklinkSourceIR, FilterExprIR, IRStatement, LinkRelationIR, OrderByIR, OverlayIR, SelectExprIREntry, SelectExprIR, SelectIR, SelectShapeElementIR } from "../ir/model.js";
import type { AccessPolicyCondition, AccessPolicyDef, FieldDef, FunctionDef, FunctionExprDef, ScalarType, ScalarValue, TypeDef } from "../types.js";
import { qualifiedTypeName } from "../schema/schema.js";
import type { SQLiteDatabase } from "../runtime/database.js";


export interface QueryResult {
  kind: "select" | "insert" | "update" | "delete";
  rows?: unknown[];
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

type IntrospectionConstraintParam = {
  name: string;
  "@value": string;
};

type IntrospectionConstraint = {
  name: string;
  delegated: boolean;
  params: IntrospectionConstraintParam[];
  annotations: IntrospectionAnnotation[];
};

type IntrospectionProperty = {
  name: string;
  target?: { name: string };
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
  indexes: Array<{ expr: string }>;
  bases: Array<{ name: string; "@index": number }>;
  ancestors: Array<{ name: string; "@index": number }>;
  properties: IntrospectionProperty[];
  links: IntrospectionLink[];
  pointersHaveAnnotations: boolean;
};

const buildIntrospectionType = (schema: SchemaSnapshot, typeDef: TypeDef): IntrospectionType => {
  const moduleName = typeDef.module ?? "default";
  const qualifiedName = `${moduleName}::${typeDef.name}`;

  const collectAncestors = (bases: string[]): Array<{ name: string; "@index": number }> => {
    const seen = new Set<string>();
    const ordered: string[] = [];

    for (const base of bases) {
      if (seen.has(base)) {
        continue;
      }
      seen.add(base);
      ordered.push(base);
    }

    const visitParents = (typeName: string): void => {
      const baseType = schema.getType(typeName);
      for (const parent of baseType?.extends ?? []) {
        if (!seen.has(parent)) {
          seen.add(parent);
          ordered.push(parent);
        }
        visitParents(parent);
      }
    };

    for (const base of bases) {
      visitParents(base);
    }

    for (const root of ["std::Object", "std::BaseObject"]) {
      if (!seen.has(root)) {
        seen.add(root);
        ordered.push(root);
      }
    }

    return ordered.map((name, index) => ({ name, "@index": index }));
  };

  const mapConstraint = (constraint: NonNullable<FieldDef["constraints"]>[number]): IntrospectionConstraint => ({
    name: constraint.name,
    delegated: typeDef.abstract ? Boolean(constraint.delegated) : false,
    params: (constraint.params ?? []).map((param) => ({
      name: param.name,
      "@value": String(param.value),
    })),
    annotations: (constraint.annotations ?? []).map((annotation) => ({
      name: annotation.name,
      "@value": annotation.value,
    })),
  });

  const properties: IntrospectionProperty[] = [
    {
      name: "id",
      annotations: [],
      constraints: [{ name: "std::exclusive", delegated: false, params: [], annotations: [] }],
    },
    ...typeDef.fields.map((field) => ({
      name: field.name,
      target: field.targetTypeName ? { name: field.targetTypeName } : undefined,
      annotations: (field.annotations ?? []).map((annotation) => ({
        name: annotation.name,
        "@value": annotation.value,
      })),
      constraints: (field.constraints ?? []).map((constraint) => mapConstraint(constraint)),
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
    indexes: (typeDef.indexes ?? []).map((index) => ({ expr: index.expr })),
    bases: (typeDef.extends ?? []).map((name, index) => ({ name, "@index": index })),
    ancestors: collectAncestors(typeDef.extends ?? []),
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

const hasTopLevelIdentifier = (source: string, identifier: string): boolean => {
  let depth = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    if (!/[A-Za-z_@]/.test(ch)) {
      continue;
    }

    const start = i;
    i += 1;
    while (i < source.length && /[A-Za-z0-9_@]/.test(source[i])) {
      i += 1;
    }
    const word = source.slice(start, i);
    if (word === identifier) {
      return true;
    }
    i -= 1;
  }

  return false;
};

const trySchemaObjectTypeQuery = (schema: SchemaSnapshot, query: string): QueryResult | undefined => {
  const isObjectTypeQuery = /\bObjectType\b/i.test(query);
  const isFunctionQuery = /\bFunction\b/i.test(query);
  const isScalarTypeQuery = /\bScalarType\b/i.test(query);
  if (!isObjectTypeQuery && !isFunctionQuery && !isScalarTypeQuery) {
    return undefined;
  }

  const looksLikeSchemaModule = /\bWITH\s+MODULE\s+schema\b/i.test(query)
    || /\bschema::ObjectType\b/i.test(query)
    || /\bschema::Function\b/i.test(query)
    || /\bschema::ScalarType\b/i.test(query);
  if (!looksLikeSchemaModule) {
    return undefined;
  }

  if (isFunctionQuery) {
    return trySchemaFunctionQuery(schema, query);
  }

  if (isScalarTypeQuery) {
    return trySchemaScalarTypeQuery(schema, query);
  }

  if (!isObjectTypeQuery) {
    return undefined;
  }

  const shape = extractObjectTypeShape(query);
  if (!shape) {
    return undefined;
  }

  const typeAnnotationsBlock = extractTopLevelBlock(shape, "annotations");
  const propertiesBlock = extractTopLevelBlock(shape, "properties");
  const linksBlock = extractTopLevelBlock(shape, "links");
  const indexesBlock = extractTopLevelBlock(shape, "indexes");
  const basesBlock = extractTopLevelBlock(shape, "bases");
  const ancestorsBlock = extractTopLevelBlock(shape, "ancestors");

  const propertyAnnotationsBlock = propertiesBlock ? extractTopLevelBlock(propertiesBlock.content, "annotations") : undefined;
  const propertyTargetBlock = propertiesBlock ? extractTopLevelBlock(propertiesBlock.content, "target") : undefined;
  const constraintsBlock = propertiesBlock ? extractTopLevelBlock(propertiesBlock.content, "constraints") : undefined;
  const constraintAnnotationsBlock = constraintsBlock ? extractTopLevelBlock(constraintsBlock.content, "annotations") : undefined;
  const constraintParamsBlock = constraintsBlock ? extractTopLevelBlock(constraintsBlock.content, "params") : undefined;

  const linkAnnotationsBlock = linksBlock ? extractTopLevelBlock(linksBlock.content, "annotations") : undefined;
  const linkPropertiesBlock = linksBlock ? extractTopLevelBlock(linksBlock.content, "properties") : undefined;
  const linkPropertyAnnotationsBlock = linkPropertiesBlock
    ? extractTopLevelBlock(linkPropertiesBlock.content, "annotations")
    : undefined;

  const includeTypeAnnotations = !!typeAnnotationsBlock;
  const includeProperties = !!propertiesBlock;
  const includeIndexes = !!indexesBlock;
  const includeBases = !!basesBlock;
  const includeAncestors = !!ancestorsBlock;
  const includePropertyAnnotations = !!propertyAnnotationsBlock;
  const includePropertyTarget = !!propertyTargetBlock;
  const includeConstraints = !!constraintsBlock;
  const includeConstraintNameRaw = constraintsBlock ? hasTopLevelIdentifier(constraintsBlock.content, "name") : false;
  const includeConstraintDelegated = constraintsBlock ? hasTopLevelIdentifier(constraintsBlock.content, "delegated") : false;
  const includeConstraintParams = !!constraintParamsBlock;
  const includeConstraintAnnotations = !!constraintAnnotationsBlock;
  const includeConstraintName = includeConstraintNameRaw && !includeConstraintAnnotations;
  const includeLinks = !!linksBlock;
  const includeLinkAnnotations = !!linkAnnotationsBlock;
  const includeLinkProperties = !!linkPropertiesBlock;
  const includeLinkPropertyAnnotations = !!linkPropertyAnnotationsBlock;
  const includeIndexExpr = indexesBlock ? /(^|\W)expr(\W|$)/i.test(indexesBlock.content) : false;

  const includeAnnotationValue = /@value/i.test(query);
  const filterExistsAnnotations = /FILTER[\s\S]*EXISTS\s+\.annotations/i.test(query);
  const filterExistsPointersAnnotations = /EXISTS\s+\.pointers\.annotations/i.test(query);
  const filterExistsIndexes = /EXISTS\s+\.indexes/i.test(query);
  const typeOrderByName = /ORDER\s+BY\s+\.name/i.test(query);
  const typeAnnotationOrderByName = typeAnnotationsBlock ? /ORDER\s+BY\s+\.name/i.test(typeAnnotationsBlock.after) : false;
  const filterObjectPropertiesExistsAnnotations = propertiesBlock
    ? /FILTER\s+EXISTS\s+\.annotations/i.test(propertiesBlock.after)
    : false;
  const filterObjectPropertiesExistsConstraints = propertiesBlock
    ? /FILTER\s+EXISTS\s+\.constraints/i.test(propertiesBlock.after)
    : false;
  const propertyNameSetMatch = propertiesBlock?.after.match(/FILTER\s+\.name\s+IN\s*\{([^}]*)\}/i);
  const propertyNameSet = propertyNameSetMatch
    ? new Set(
        propertyNameSetMatch[1]
          .split(",")
          .map((entry) => entry.trim().replace(/^'+|'+$/g, ""))
          .filter((entry) => entry.length > 0),
      )
    : undefined;
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
  const equalsNames = new Set([...query.matchAll(/\.name\s*=\s*'([^']+)'/gi)].map((match) => match[1]));

  const rows = schema.listTypes().map((typeDef) => {
    const introspectionType = buildIntrospectionType(schema, typeDef);
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

    if (includeIndexes) {
      row.indexes = introspectionType.indexes.map((index) => ({
        ...(includeIndexExpr ? { expr: index.expr } : {}),
      }));
    }

    if (includeBases) {
      row.bases = introspectionType.bases.map((base) => ({
        name: base.name,
        "@index": base["@index"],
      }));
    }

    if (includeAncestors) {
      row.ancestors = introspectionType.ancestors.map((ancestor) => ({
        name: ancestor.name,
        "@index": ancestor["@index"],
      }));
    }

    if (includeProperties) {
      let properties = introspectionType.properties.slice();
      if (filterObjectPropertiesExistsAnnotations) {
        properties = properties.filter((property) => property.annotations.length > 0);
      }
      if (filterObjectPropertiesExistsConstraints) {
        properties = properties.filter((property) => property.constraints.length > 0);
      }
      if (propertyNameSet) {
        properties = properties.filter((property) => propertyNameSet.has(property.name));
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
        if (includePropertyTarget && property.target) {
          out.target = { name: property.target.name };
        }
        if (includeConstraints) {
          const projectedConstraints =
            includeConstraintAnnotations && !includeConstraintName && !includeConstraintDelegated && !includeConstraintParams
              ? property.constraints.filter((constraint) =>
                  constraint.annotations.length > 0 || constraint.name === "std::exclusive")
              : property.constraints;

          out.constraints = projectedConstraints.map((constraint) => ({
            ...(includeConstraintName ? { name: constraint.name } : {}),
            ...(includeConstraintDelegated ? { delegated: constraint.delegated } : {}),
            ...(includeConstraintParams
              ? {
                  params: constraint.params
                    .filter((param) => param.name !== "__subject__")
                    .map((param) => ({ name: param.name, "@value": param["@value"] })),
                }
              : {}),
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
    const rowName = typeof row.name === "string" ? row.name : String(row.name);

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

    if (filterExistsIndexes) {
      if (introspectionType.indexes.length === 0) {
        return false;
      }
    }

    if (likePattern) {
      if (likePattern.endsWith("%")) {
        const prefix = likePattern.slice(0, -1);
        return rowName.startsWith(prefix);
      }
      return rowName === likePattern;
    }

    if (equalsNames.size > 0 && !equalsNames.has(rowName)) {
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

const trySchemaFunctionQuery = (schema: SchemaSnapshot, query: string): QueryResult | undefined => {
  const includeAnnotations = /annotations\s*:\s*\{/i.test(query);
  const includeAnnotationValue = /@value/i.test(query);
  const includeVolatility = /\bvol\s*:=\s*<str>\s*\.volatility\b/i.test(query) || /\bvolatility\b/i.test(query);
  const filterExistsAnnotations = /FILTER[\s\S]*EXISTS\s+\.annotations/i.test(query);
  const likeMatch = query.match(/\.name\s+LIKE\s+'([^']+)'/i);
  const likePattern = likeMatch?.[1];
  const orderByName = /ORDER\s+BY\s+\.name/i.test(query);

  let rows = schema.listFunctions().map((fn) => {
    const row: Record<string, unknown> = {
      name: `${fn.module}::${fn.name}`,
    };
    if (includeAnnotations) {
      row.annotations = (fn.annotations ?? []).map((annotation) => ({
        name: annotation.name,
        ...(includeAnnotationValue ? { "@value": annotation.value } : {}),
      }));
    }
    if (includeVolatility) {
      row.vol = fn.volatility ?? null;
    }
    return row;
  });

  rows = rows.filter((row) => {
    const rowName = String(row.name);
    if (filterExistsAnnotations) {
      const annotations = (row.annotations as unknown[] | undefined) ?? [];
      if (annotations.length === 0) {
        return false;
      }
    }

    if (likePattern) {
      if (likePattern.endsWith("%")) {
        const prefix = likePattern.slice(0, -1);
        if (!rowName.startsWith(prefix)) {
          return false;
        }
      } else if (rowName !== likePattern) {
        return false;
      }
    }

    return true;
  });

  if (orderByName) {
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  return {
    kind: "select",
    rows,
  };
};

const scalarAncestorsForDeclaration = (
  schema: SchemaSnapshot,
  scalarName: string,
  baseTypeName: string | undefined,
  enumValues: string[] | undefined,
  seen = new Set<string>(),
): string[] => {
  if (seen.has(scalarName)) {
    return [];
  }
  seen.add(scalarName);

  if (enumValues && enumValues.length > 0) {
    return ["std::anyenum", "std::anyscalar"];
  }

  const base = (baseTypeName ?? "str").trim();
  const lower = base.includes("::") ? base.split("::").at(-1)!.toLowerCase() : base.toLowerCase();

  if (lower === "anyenum") {
    return ["std::anyenum", "std::anyscalar"];
  }
  if (lower === "str" || lower === "bytes") {
    return ["std::str", "std::anyscalar"];
  }
  if (lower === "int" || lower === "int64") {
    return ["std::int64", "std::anyint", "std::anyreal", "std::anydiscrete", "std::anypoint", "std::anyscalar"];
  }
  if (lower === "int32") {
    return ["std::int32", "std::anyint", "std::anyreal", "std::anydiscrete", "std::anypoint", "std::anyscalar"];
  }
  if (lower === "int16") {
    return ["std::int16", "std::anyint", "std::anyreal", "std::anydiscrete", "std::anypoint", "std::anyscalar"];
  }
  if (lower === "bool") {
    return ["std::bool", "std::anyscalar"];
  }

  const qualifiedBase = base.includes("::") ? base : `${scalarName.split("::")[0]}::${base}`;
  const baseDecl = schema.getScalarType(qualifiedBase);
  if (baseDecl) {
    return [qualifiedBase, ...scalarAncestorsForDeclaration(schema, qualifiedBase, baseDecl.baseTypeName, baseDecl.enumValues, seen)];
  }

  return [qualifiedBase, "std::anyscalar"];
};

const trySchemaScalarTypeQuery = (schema: SchemaSnapshot, query: string): QueryResult | undefined => {
  const includeAncestors = /ancestors\s*:\s*\{/i.test(query);
  const includeConstraints = /constraints\s*:\s*\{/i.test(query);
  const includeConstraintParams = /params\s*:\s*\{/i.test(query);
  const likeMatch = query.match(/\.name\s+LIKE\s+'([^']+)'/i);
  const likePattern = likeMatch?.[1];
  const orderByName = /ORDER\s+BY\s+\.name/i.test(query);

  let rows = schema.listScalarTypes().map((scalarType) => {
    const qualifiedName = `${scalarType.module}::${scalarType.name}`;
    const row: Record<string, unknown> = {
      name: qualifiedName,
    };

    if (includeAncestors) {
      row.ancestors = scalarAncestorsForDeclaration(
        schema,
        qualifiedName,
        scalarType.baseTypeName,
        scalarType.enumValues,
      ).map((ancestor) => ({ name: ancestor }));
    }

    if (includeConstraints) {
      row.constraints = (scalarType.constraints ?? []).map((constraint) => ({
        name: constraint.name,
        ...(includeConstraintParams
          ? {
              params: (constraint.params ?? [])
                .filter((param) => param.name !== "__subject__")
                .map((param) => ({ name: param.name, "@value": String(param.value) })),
            }
          : {}),
      }));
    }

    return row;
  });

  if (likePattern) {
    rows = rows.filter((row) => {
      const rowName = String(row.name);
      if (likePattern.endsWith("%")) {
        return rowName.startsWith(likePattern.slice(0, -1));
      }
      return rowName === likePattern;
    });
  }

  if (orderByName) {
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  return {
    kind: "select",
    rows,
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
    const compiled = compilerService.compile(schema, ast, { globals: context.globals, target: runtimeTarget });
    const ir = compiled.ir;
    const subjectType = ir.kind === "insert" || ir.kind === "update" || ir.kind === "delete"
      ? typeDefForTable(schema, ir.table)
      : undefined;
    if ((ir.kind === "insert" || ir.kind === "update" || ir.kind === "delete") && !subjectType) {
      const astTypeName = "typeName" in ast ? ast.typeName : "<unknown>";
      throw new AppError("E_SEMANTIC", `Unknown type '${astTypeName}'`, ast.pos.line, ast.pos.column);
    }
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
    } else if (ir.kind === "select_expr") {
      result = {
        kind: "select",
        rows: materializeSelectExprRows(db, schema, ir, context, sqlTrail),
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
      if (ast.kind === "for") {
        executeForLoop(db, schema, ast, context, runtimeTarget, compilerService, overlays, traces);
        continue;
      }

      const statementType = statementTypeOf(ast);
      enforceBuiltinPermissions(context, statementType, ast.pos.line, ast.pos.column);
      const astSubjectType = ast.kind === "insert" || ast.kind === "update" || ast.kind === "delete"
        ? schema.getType(ast.typeName)
        : undefined;
      if (ast.kind === "insert" && !astSubjectType && Object.keys(ast.values).length === 0 && !ast.conflict) {
        continue;
      }

      const compiled = compilerService.compile(schema, ast, { overlays, globals: context.globals, target: runtimeTarget });
      const ir = compiled.ir;
      const sqlArtifact = compiled.sql;
      assertTargetSqlCompatibility(sqlArtifact.sql, runtimeTarget);
      const sqlTrail: SQLArtifact[] = [sqlArtifact];

      const subjectType = ir.kind === "insert" || ir.kind === "update" || ir.kind === "delete"
        ? typeDefForTable(schema, ir.table)
        : undefined;
      if ((ir.kind === "insert" || ir.kind === "update" || ir.kind === "delete") && !subjectType) {
        const astTypeName = "typeName" in ast ? ast.typeName : "<unknown>";
        throw new AppError("E_SEMANTIC", `Unknown type '${astTypeName}'`, ast.pos.line, ast.pos.column);
      }

      let result: QueryResult;
      if (ir.kind === "select") {
        result = { kind: "select", rows: runSelectIR(db, schema, ir, context, sqlArtifact, sqlTrail) };
      } else if (ir.kind === "select_free") {
        result = { kind: "select", rows: [materializeFreeObjectRow(db, schema, ir.entries, context, sqlTrail)] };
      } else if (ir.kind === "select_expr") {
        result = { kind: "select", rows: materializeSelectExprRows(db, schema, ir, context, sqlTrail) };
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
      result: traces.length > 0 ? traces[traces.length - 1].result : { kind: "insert", changes: 0 },
    };
  } catch (err) {
    throw asAppError(err);
  }
};

const substituteBindingInASTFilter = (
  filter: import("../edgeql/ast.js").FilterExpr,
  variable: string,
  value: ScalarValue,
): import("../edgeql/ast.js").FilterExpr => {
  if (filter.kind === "predicate") {
    const fv = filter.value;
    if (typeof fv === "object" && fv !== null && "kind" in fv && fv.kind === "binding_ref" && fv.name === variable) {
      return { ...filter, value };
    }
    return filter;
  }
  if (filter.kind === "and" || filter.kind === "or") {
    return {
      ...filter,
      left: substituteBindingInASTFilter(filter.left, variable, value),
      right: substituteBindingInASTFilter(filter.right, variable, value),
    };
  }
  if (filter.kind === "not") {
    return {
      ...filter,
      expr: substituteBindingInASTFilter(filter.expr, variable, value),
    };
  }
  return filter;
};

const executeForLoop = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: ForStatement,
  context: SecurityContext,
  runtimeTarget: RuntimeTarget,
  compilerService: ReturnType<typeof getCompilerService>,
  overlays: OverlayIR[],
  traces: QueryExecutionTrace[],
): void => {
  const iteratorExpr = ast.iteratorExpr;
  const body = ast.body;
  const iteratorValues = evaluateForIteratorValues(iteratorExpr, schema, db, context);

  if (body.kind === "insert") {
    for (const value of iteratorValues) {
      const insertValues: Record<string, InsertValue> = {};
      for (const [key, v] of Object.entries(body.values)) {
        if (typeof v === "object" && v !== null && "kind" in v && v.kind === "binding_ref" && v.name === ast.variable) {
          insertValues[key] = value as InsertValue;
        } else {
          insertValues[key] = v;
        }
      }

      const insertAst: InsertStatement = {
        ...body,
        values: insertValues,
      };

      const subjectType = schema.getType(insertAst.typeName);
      if (!subjectType) {
        throw new AppError("E_SEMANTIC", `Unknown type '${insertAst.typeName}'`, ast.pos.line, ast.pos.column);
      }

      const compiled = compilerService.compile(schema, insertAst, { overlays, globals: context.globals, target: runtimeTarget });
      const ir = compiled.ir;
      const sqlArtifact = compiled.sql;
      assertTargetSqlCompatibility(sqlArtifact.sql, runtimeTarget);
      const sqlTrail: SQLArtifact[] = [sqlArtifact];

      const writeResult = runWriteWithAccessPolicies(db, schema, insertAst, ir, sqlArtifact, subjectType, context);
      const result = { kind: "insert" as const, changes: writeResult.changes };

      const currentOverlays = extractOverlays(ir);
      if (ir.kind !== "select" && ir.kind !== "select_free" && ir.kind !== "select_expr") {
        overlays.push(...currentOverlays);
      }

      traces.push({
        ast: insertAst,
        ir,
        sql: sqlArtifact,
        compiler: compiled.cache,
        sqlTrail,
        overlays: currentOverlays,
        result,
      });
    }
  } else {
    for (const value of iteratorValues) {
      const selectAst = bindSelectAstVariable(body, ast.variable, value);

      const compiled = compilerService.compile(schema, selectAst, { overlays, globals: context.globals, target: runtimeTarget });
      const ir = compiled.ir as SelectIR;
      const sqlArtifact = compiled.sql;
      assertTargetSqlCompatibility(sqlArtifact.sql, runtimeTarget);
      const sqlTrail: SQLArtifact[] = [sqlArtifact];

      const rows = runSelectIR(db, schema, ir, context, sqlArtifact, sqlTrail);

      const currentOverlays = extractOverlays(ir);
      overlays.push(...currentOverlays);

      traces.push({
        ast: selectAst,
        ir,
        sql: sqlArtifact,
        compiler: compiled.cache,
        sqlTrail,
        overlays: currentOverlays,
        result: { kind: "select" as const, rows },
      });
    }
  }
};

const evaluateForIteratorValues = (
  expr: ForStatement["iteratorExpr"],
  schema: SchemaSnapshot,
  db: SQLiteDatabase,
  context: SecurityContext,
): unknown[] => {
  if (expr.kind === "literal") {
    return [expr.value];
  }

  if (expr.kind === "set_literal") {
    return expr.values;
  }

  if (expr.kind === "function_call") {
    const args: RuntimeFunctionArg[] = expr.call.args.map((arg) => {
      if (arg.kind === "literal") return arg.value;
      if (arg.kind === "set_literal") return { kind: "array", values: arg.values };
      if (arg.kind === "array_literal") return { kind: "array", values: arg.values };
      return null;
    });
    const qualifiedName = expr.call.name.includes("::")
      ? expr.call.name
      : `default::${expr.call.name}`;
    const fnResult = executeFunctionCall(schema, db, context, qualifiedName, args);
    return Array.isArray(fnResult) ? fnResult : [fnResult];
  }

  if (expr.kind === "concat") {
    let results: unknown[] = [""];
    for (const part of expr.parts) {
      const partValues = evaluateForIteratorValues(part as ForStatement["iteratorExpr"], schema, db, context);
      const next: unknown[] = [];
      for (const left of results) {
        for (const right of partValues) {
          if (typeof left === "string" && typeof right === "string") {
            next.push(left + right);
          } else if (left === null || left === undefined) {
            next.push(right);
          } else if (right === null || right === undefined) {
            next.push(left);
          } else {
            next.push(`${left}${right}`);
          }
        }
      }
      results = next;
    }
    return results.length > 0 ? results : [null];
  }

  return [null];
};

const bindSelectAstVariable = (
  body: SelectStatement,
  variable: string,
  value: unknown,
): SelectStatement => {
  const scalar = coerceUnknownToScalar(value);
  if (!scalar) {
    return {
      ...body,
      filter: body.filter,
    };
  }

  const existing = (body.with ?? []).filter((binding) => binding.name !== variable);
  return {
    ...body,
    with: [...existing, { name: variable, value: { kind: "literal", value: scalar } }],
    filter: body.filter ? substituteBindingInASTFilter(body.filter, variable, scalar) : undefined,
  };
};

const ensureSelectAstHasId = (ast: SelectStatement): SelectStatement => {
  const hasId = ast.shape.some((element) => element.kind === "field" && element.name === "id");
  if (hasId) {
    return ast;
  }

  const shape = [{ kind: "field", name: "id" } as const, ...ast.shape];
  const fields = ast.fields.includes("id") ? ast.fields : ["id", ...ast.fields];
  return {
    ...ast,
    shape,
    fields,
  };
};

const coerceUnknownToScalar = (value: unknown): ScalarValue | undefined => {
  if (isScalarValue(value)) {
    return value;
  }

  if (Array.isArray(value) || (value !== null && typeof value === "object")) {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }

  return undefined;
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
      } else if (element.expr.kind === "type_name") {
        output[element.name] = sourceType;
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

        const resolveShapeFunctionArg = (arg: typeof element.expr.args[number]): RuntimeFunctionArg => {
          if (arg.kind === "field_ref") {
            return row[arg.column] as ScalarValue;
          }
          if (arg.kind === "set_literal") {
            return { kind: "set" as const, values: [...arg.values] };
          }
          if (arg.kind === "array_literal") {
            return { kind: "array" as const, values: [...arg.values] };
          }
          if (arg.kind === "function_call") {
            return executeFunctionCall(
              schema,
              db,
              context,
              arg.functionName,
              arg.args.map((nested) => resolveShapeFunctionArg(nested)),
            ) as RuntimeFunctionArg;
          }
          return arg.value;
        };

        const args: RuntimeFunctionArg[] = element.expr.args.map((arg) => resolveShapeFunctionArg(arg));
        output[element.name] = executeFunctionCall(schema, db, context, element.expr.functionName, args);
      } else if (element.expr.kind === "link_aggregate") {
        const loweredAlias = computedValueAlias(element.pathId);
        if (Object.prototype.hasOwnProperty.call(row, loweredAlias)) {
          output[element.name] = row[loweredAlias];
          continue;
        }

        const relation = element.expr.relation;
        const targetSource = compilePolymorphicTargetSource(db, relation, "t", [element.expr.column]);
        let sql: string;
        let params: ScalarValue[];
        if (relation.storage === "inline") {
          const targetId = row[relation.inlineColumn!];
          if (!isScalarValue(targetId) || targetId === null) {
            output[element.name] = 0;
            continue;
          }
          sql = `SELECT COALESCE(SUM(t.${quoteIdent(element.expr.column)}), 0) AS ${quoteIdent("value")} FROM ${targetSource} WHERE t.${quoteIdent("id")} = ?`;
          params = [targetId];
        } else {
          const sourceId = row.id;
          if (!isScalarValue(sourceId) || sourceId === null) {
            output[element.name] = 0;
            continue;
          }
          sql = `SELECT COALESCE(SUM(t.${quoteIdent(element.expr.column)}), 0) AS ${quoteIdent("value")} FROM ${targetSource} JOIN ${quoteIdent(relation.linkTable!)} l ON l.${quoteIdent("target")} = t.${quoteIdent("id")} WHERE l.${quoteIdent("source")} = ?`;
          params = [sourceId];
        }
        sqlTrail.push({ sql, params: [...params], loweringMode: "fallback_multi_query" });
        const aggregateRow = db.prepare(sql).all(...params)[0] as { value?: unknown } | undefined;
        output[element.name] = Number(aggregateRow?.value ?? 0);
      } else if (element.expr.kind === "field_suffix_math") {
        const raw = row[element.expr.field];
        const asText = raw === null || raw === undefined ? "" : String(raw);
        const index = asText.length - element.expr.fromEnd;
        const digit = index >= 0 ? Number(asText[index]) : Number.NaN;
        if (!Number.isFinite(digit)) {
          output[element.name] = null;
        } else if (element.expr.op === "negate") {
          output[element.name] = -digit;
        } else {
          output[element.name] = (element.expr.constant ?? 0) - digit;
        }
      } else {
        output[element.name] = { name: sourceType };
      }
      continue;
    }

    if (element.kind === "link") {
      if (element.sourceTypeFilter && element.sourceTypeFilter !== sourceType) {
        output[element.name] = element.relation.multi ? [] : null;
        continue;
      }

      const payload = parsePayloadArray(row[shapePayloadAlias(element.pathId)]);
      if (payload) {
        const materialized = element.relation.multi ? payload : (payload[0] ?? null);
        output[element.name] = materialized;
        continue;
      }

      const links = resolveLinks(db, schema, context, row, element.relation, element.typeFilter, {
        columns: element.columns,
        shape: element.shape,
        filter: element.filter,
        orderBy: element.orderBy,
        limit: element.limit,
        offset: element.offset,
      }, sqlTrail);
      const materialized = element.relation.multi ? links : (links[0] ?? null);
      output[element.name] = materialized;
      continue;
    }

    const payload = parsePayloadArray(row[shapePayloadAlias(element.pathId)]);
    if (payload && !(element.columns && element.shape)) {
      output[element.name] = payload;
      continue;
    }

    const targetId = row.id;
    if (!isScalarValue(targetId)) {
      output[element.name] = [];
      continue;
    }

    if (element.columns && element.shape) {
      output[element.name] = resolveBacklinkObjects(db, schema, context, element.sources, targetId, {
        columns: element.columns,
        shape: element.shape,
        filter: element.filter,
        orderBy: element.orderBy,
        limit: element.limit,
        offset: element.offset,
      }, sqlTrail);
      continue;
    }

    output[element.name] = resolveBacklinks(db, element.sources, targetId, sqlTrail);
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

  if (field.collection && typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (field.collection.kind === "array") {
          return Array.isArray(parsed) ? parsed : [];
        }

        if (field.collection.kind === "tuple") {
          if (Array.isArray(parsed) && field.collection.elementNames && field.collection.elementNames.length === parsed.length) {
            return Object.fromEntries(field.collection.elementNames.map((name, idx) => [name, parsed[idx]]));
          }
          return parsed;
        }
      } catch {
        return value;
      }
    }
  }

  return coerceScalarForOutput(field.type, value);
};

const findFieldDef = (
  schema: SchemaSnapshot,
  typeName: string,
  fieldName: string,
  seen = new Set<string>(),
): TypeDef["fields"][number] | undefined => {
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

const linkDefsEquivalent = (a: NonNullable<TypeDef["links"]>[number], b: NonNullable<TypeDef["links"]>[number]): boolean => {
  if (a.name !== b.name) {
    return false;
  }
  if ((a.targetType ?? "") !== (b.targetType ?? "")) {
    return false;
  }
  if (Boolean(a.multi) !== Boolean(b.multi)) {
    return false;
  }

  const aProps = a.properties ?? [];
  const bProps = b.properties ?? [];
  if (aProps.length !== bProps.length) {
    return false;
  }
  for (let i = 0; i < aProps.length; i += 1) {
    const ap = aProps[i];
    const bp = bProps[i];
    if (!bp || ap.name !== bp.name || ap.type !== bp.type) {
      return false;
    }
  }

  return true;
};

const resolveLinkStorageOwner = (
  schema: SchemaSnapshot,
  typeDef: TypeDef,
  link: NonNullable<TypeDef["links"]>[number],
): TypeDef => {
  if (link.overloaded) {
    return typeDef;
  }

  let owner = typeDef;
  let current = typeDef;

  while ((current.extends ?? []).length > 0) {
    const nextBaseName = current.extends?.[0];
    if (!nextBaseName) {
      break;
    }

    const baseType = schema.getType(nextBaseName);
    if (!baseType) {
      break;
    }

    const baseLink = (baseType.links ?? []).find((candidate) => candidate.name === link.name);
    if (!baseLink || baseLink.overloaded || !linkDefsEquivalent(link, baseLink)) {
      break;
    }

    owner = baseType;
    current = baseType;
  }

  return owner;
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
          const resolveFreeFunctionArg = (value: typeof arg): RuntimeFunctionArg => {
            if (value.kind === "set_literal") {
              return { kind: "set" as const, values: [...value.values] };
            }
            if (value.kind === "array_literal") {
              return { kind: "array" as const, values: [...value.values] };
            }
            if (value.kind === "binding_ref") {
              return context.globals?.[value.name] ?? null;
            }
            if (value.kind === "function_call") {
              return executeFunctionCall(
                schema,
                db,
                context,
                value.functionName,
                value.args.map((nested) => resolveFreeFunctionArg(nested)),
              ) as RuntimeFunctionArg;
            }
            return value.value;
          };

          return resolveFreeFunctionArg(arg);
        }),
      );
      continue;
    }

    if (entry.kind === "select") {
      const nestedSql = compileToSQL(entry.query, { target: resolvedRuntimeTarget(context, db) });
      assertTargetSqlCompatibility(nestedSql.sql, resolvedRuntimeTarget(context, db));
      sqlTrail.push(nestedSql);
      out[entry.name] = runSelectIR(db, schema, entry.query, context, nestedSql, sqlTrail);
      continue;
    }
  }

  return out;
};

const evaluateSelectExprEntry = (
  schema: SchemaSnapshot,
  db: SQLiteDatabase,
  context: SecurityContext,
  entry: SelectExprIREntry,
  sqlTrail: SQLArtifact[],
  evalContext?: {
    currentBinding?: string;
    currentValue?: unknown;
  },
): unknown => {
  switch (entry.kind) {
    case "literal":
      return entry.value;
    case "set_literal":
      return [...entry.values];
    case "set_expr":
      return entry.values.flatMap((value) => {
        const item = evaluateSelectExprEntry(schema, db, context, value, sqlTrail, evalContext);
        return Array.isArray(item) ? item : [item];
      });
    case "enum_path":
      return entry.member;
    case "current_item":
      if (evalContext?.currentBinding === entry.bindingName) {
        return evalContext.currentValue ?? null;
      }
      return null;
    case "type_field_path": {
      const typeDef = schema.getType(entry.typeName);
      if (!typeDef) {
        throw new AppError("E_SEMANTIC", `Unknown type '${entry.typeName}'`, 1, 1);
      }
      const field = typeDef.fields.find((f) => f.name === entry.field);
      if (!field) {
        const computed = typeDef.computeds?.find((computed) => computed.kind === "property" && computed.name === entry.field);
        if (!computed || computed.kind !== "property") {
          throw new AppError("E_SEMANTIC", `Unknown field '${entry.field}' on '${entry.typeName}'`, 1, 1);
        }

        if (computed.expr.kind === "literal") {
          return computed.expr.value;
        }
        if (computed.expr.kind === "field_ref") {
          const rows = db.prepare(`SELECT ${computed.expr.field} FROM ${tableNameForType(entry.typeName)} LIMIT 1`).all();
          return rows.length > 0 ? rows[0]?.[computed.expr.field] ?? null : null;
        }
        if (computed.expr.kind === "concat") {
          return computed.expr.parts
            .map((part) => {
              if (part.kind === "literal") {
                return String(part.value ?? "");
              }
              const rows = db.prepare(`SELECT ${part.field} FROM ${tableNameForType(entry.typeName)} LIMIT 1`).all();
              return String(rows.length > 0 ? rows[0]?.[part.field] ?? "" : "");
            })
            .join("");
        }
        if (computed.expr.kind === "function_call") {
          return executeFunctionCall(schema, db, context, computed.expr.name, computed.expr.args as RuntimeFunctionArg[]);
        }
        if (computed.expr.kind === "link_aggregate") {
          return 0;
        }
        return null;
      }
      const rows = db.prepare(`SELECT ${entry.field} FROM ${tableNameForType(entry.typeName)} LIMIT 1`).all();
      const value = rows.length > 0 ? rows[0]?.[entry.field] ?? null : null;
      return value;
    }
    case "cast": {
      if (entry.value.kind === "set_literal" || entry.value.kind === "set_expr") {
        const setValues = evaluateSelectExprEntry(schema, db, context, entry.value, sqlTrail, evalContext);
        if (Array.isArray(setValues)) {
          return setValues;
        }
        const castTypeDef = schema.getType(entry.castType);
        if (castTypeDef) {
          const allEnumValues = castTypeDef.fields.flatMap((f) => f.enumValues ?? []);
          if (allEnumValues.length > 0) {
            return [setValues];
          }
        }
        return [setValues];
      }
      const innerValue = evaluateSelectExprEntry(schema, db, context, entry.value, sqlTrail, evalContext);
      if (entry.castType === "str") {
        if (Array.isArray(innerValue)) {
          return innerValue.map((item) => String(item ?? ""));
        }
        if (innerValue === null) return "";
        return String(innerValue);
      }
      if (entry.castType === "json") {
        return JSON.stringify(innerValue);
      }
      const castTypeDef = schema.getType(entry.castType);
      if (castTypeDef) {
        const allEnumValues = castTypeDef.fields.flatMap((f) => f.enumValues ?? []);
        if (allEnumValues.length > 0) {
          if (innerValue === null) {
            return null;
          }
          if (typeof innerValue !== "string") {
            throw new AppError("E_SEMANTIC", `Cannot cast to enum '${entry.castType}': expected string value`, 1, 1);
          }
          if (!allEnumValues.includes(innerValue)) {
            throw new AppError("E_SEMANTIC", `invalid input value for enum '${entry.castType}': "${innerValue}"`, 1, 1);
          }
          return innerValue;
        }
      }
      throw new AppError("E_SEMANTIC", `Unsupported cast type '${entry.castType}' in select_expr`, 1, 1);
    }
    case "is_type": {
      const value = evaluateSelectExprEntry(schema, db, context, entry.value, sqlTrail, evalContext);
      const typeDef = schema.getType(entry.typeName);
      const enumValues = typeDef?.fields.flatMap((f) => f.enumValues ?? []) ?? [];
      const checkOne = (item: unknown): boolean => {
        if (enumValues.length > 0) {
          return typeof item === "string" && enumValues.includes(item);
        }
        return false;
      };
      if (Array.isArray(value)) {
        return value.map(checkOne);
      }
      return checkOne(value);
    }
    case "select_expr_subquery": {
      const value = evaluateSelectExprEntry(schema, db, context, entry.value, sqlTrail, evalContext);
      const rows = Array.isArray(value) ? [...value] : [value];
      if (entry.orderBy) {
        const inferredEnumOrder = entry.orderBy.value.kind === "current_item"
          && rows.every((item) => typeof item === "string")
          ? (() => {
              const values = rows as string[];
              for (const typeDef of schema.listTypes()) {
                const enumValues = typeDef.fields.flatMap((f) => f.enumValues ?? []);
                if (enumValues.length === 0) {
                  continue;
                }
                if (values.every((value) => enumValues.includes(value))) {
                  return new Map(enumValues.map((enumValue, index) => [enumValue, index] as const));
                }
              }
              return undefined;
            })()
          : undefined;

        rows.sort((a, b) => {
          const aKey = evaluateSelectExprEntry(
            schema,
            db,
            context,
            entry.orderBy!.value,
            sqlTrail,
            { currentBinding: entry.alias, currentValue: a },
          );
          const bKey = evaluateSelectExprEntry(
            schema,
            db,
            context,
            entry.orderBy!.value,
            sqlTrail,
            { currentBinding: entry.alias, currentValue: b },
          );
          if (aKey === bKey) {
            return 0;
          }
          if (inferredEnumOrder && typeof aKey === "string" && typeof bKey === "string") {
            const aIndex = inferredEnumOrder.get(aKey) ?? Number.MAX_SAFE_INTEGER;
            const bIndex = inferredEnumOrder.get(bKey) ?? Number.MAX_SAFE_INTEGER;
            if (aIndex === bIndex) {
              return 0;
            }
            const enumDirection = entry.orderBy!.direction === "desc" ? -1 : 1;
            return (aIndex < bIndex ? -1 : 1) * enumDirection;
          }
          if (entry.orderBy!.direction === "desc") {
            return String(aKey).localeCompare(String(bKey)) * -1;
          }
          return String(aKey).localeCompare(String(bKey));
        });
      }
      return rows;
    }
    case "function_call": {
      return executeFunctionCall(
        schema,
        db,
        context,
        entry.functionName,
        entry.args.map((arg): RuntimeFunctionArg => {
          const value = evaluateSelectExprEntry(schema, db, context, arg, sqlTrail, evalContext);
          if (Array.isArray(value)) {
            return { kind: "set", values: value as ScalarValue[] };
          }
          return value as ScalarValue;
        }),
      );
    }
    case "concat": {
      const parts = entry.parts.map((part) => evaluateSelectExprEntry(schema, db, context, part, sqlTrail, evalContext));
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const partEntry = entry.parts[i];
        if (part instanceof AppError) {
          throw part;
        }
        if (partEntry.kind === "type_field_path") {
          const typeDef = schema.getType(partEntry.typeName);
          if (typeDef) {
            const field = typeDef.fields.find((f) => f.name === partEntry.field);
            if (field?.enumValues && field.enumValues.length > 0) {
              const fieldType = field.enumTypeName ?? `std::${field.type}`;
              throw new AppError("E_SEMANTIC", `operator '++' cannot be applied to operands of type 'std::str' and '${fieldType}'`, 1, 1);
            }
          }
        }
        if (typeof part !== "string") {
          throw new AppError("E_SEMANTIC", `operator '++' cannot be applied to operands of type 'std::str' and '${typeof part}'`, 1, 1);
        }
      }
      return parts.join("");
    }
  }
};

const materializeSelectExprRows = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ir: SelectExprIR,
  context: SecurityContext,
  sqlTrail: SQLArtifact[],
): unknown[] => {
  if (ir.entries.length === 0) {
    return [];
  }
  const value = evaluateSelectExprEntry(schema, db, context, ir.entries[0], sqlTrail);
  let rows = Array.isArray(value) ? [...value] : [value];

  if (ir.orderBy) {
    const enumOrder = ir.orderBy.value.kind === "cast"
      ? (() => {
          const typeDef = schema.getType(ir.orderBy!.value.castType);
          const values = typeDef?.fields.flatMap((f) => f.enumValues ?? []) ?? [];
          if (values.length === 0) {
            return undefined;
          }
          return new Map(values.map((value, index) => [value, index] as const));
        })()
      : undefined;

    rows.sort((a, b) => {
      const aKey = evaluateSelectExprEntry(
        schema,
        db,
        context,
        ir.orderBy!.value,
        sqlTrail,
        { currentBinding: ir.currentBinding, currentValue: a },
      );
      const bKey = evaluateSelectExprEntry(
        schema,
        db,
        context,
        ir.orderBy!.value,
        sqlTrail,
        { currentBinding: ir.currentBinding, currentValue: b },
      );

      if (aKey === bKey) {
        return 0;
      }

      const direction = ir.orderBy!.direction === "desc" ? -1 : 1;
      if (enumOrder && typeof aKey === "string" && typeof bKey === "string") {
        const aIndex = enumOrder.get(aKey) ?? Number.MAX_SAFE_INTEGER;
        const bIndex = enumOrder.get(bKey) ?? Number.MAX_SAFE_INTEGER;
        if (aIndex === bIndex) {
          return 0;
        }
        return (aIndex < bIndex ? -1 : 1) * direction;
      }
      return String(aKey).localeCompare(String(bKey)) * direction;
    });
  }

  return rows;
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
    const firstRow = result.rows[0];
    if (result.rows.length === 1 && isRecordRow(firstRow) && Object.keys(firstRow).length === 1) {
      return Object.values(firstRow)[0];
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
    return `{${value.map((item) => literalToEdgeQL(item)).join(", ")}}`;
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
    orderBy?: OrderByIR<string>;
    limit?: number;
    offset?: number;
  },
  sqlTrail: SQLArtifact[],
): Record<string, unknown>[] => {
  const collectFilterColumns = (filter: FilterExprIR | undefined): string[] => {
    if (!filter) {
      return [];
    }
    if (filter.kind === "field") {
      return filter.column.startsWith("@") ? [] : [filter.column];
    }
    if (filter.kind === "field_in") {
      return filter.column.startsWith("@") ? [] : [filter.column];
    }
    if (filter.kind === "field_compare") {
      return [filter.leftColumn, filter.rightColumn].filter((column) => !column.startsWith("@"));
    }
    if (filter.kind === "not") {
      return collectFilterColumns(filter.expr);
    }
    if (filter.kind === "and" || filter.kind === "or") {
      return [...collectFilterColumns(filter.left), ...collectFilterColumns(filter.right)];
    }
    return [];
  };

  const params: ScalarValue[] = [];
  const requiredColumns = [
    ...nested.columns,
    ...(nested.orderBy ? [nested.orderBy.value] : []),
    ...collectFilterColumns(nested.filter),
  ];
  const targetSource = compilePolymorphicTargetSource(db, relation, "t", requiredColumns);
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
    sql += ` AND ${compileNestedFilterExprSQL(nested.filter, params, relation.storage === "table" ? "l" : undefined)}`;
  }

  if (nested.orderBy) {
    sql += ` ORDER BY ${quoteIdent(nested.orderBy.value)} ${nested.orderBy.direction.toUpperCase()}`;
  }

  if (nested.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(nested.limit);
  }

  if (nested.offset !== undefined) {
    sql += " OFFSET ?";
    params.push(nested.offset);
  }

  const rows = db.prepare(sql).all(...params);
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

const resolveBacklinkObjects = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  context: SecurityContext,
  sources: BacklinkSourceIR[],
  targetId: ScalarValue,
  nested: {
    columns: string[];
    shape: SelectShapeElementIR[];
    filter?: FilterExprIR;
    orderBy?: OrderByIR<string>;
    limit?: number;
    offset?: number;
  },
  sqlTrail: SQLArtifact[],
): Record<string, unknown>[] => {
  const rows: Array<Record<string, unknown> & { __source_type: string }> = [];
  const seen = new Set<string>();

  for (const source of sources) {
    const params: ScalarValue[] = [targetId];
    const queryColumns = nested.columns.includes("id") ? nested.columns : ["id", ...nested.columns];
    const projected = queryColumns
      .map((column) => `t.${quoteIdent(column)} AS ${quoteIdent(column)}`)
      .join(", ");
    const sourceTypeSelectDefault = `'${source.sourceType.replaceAll("'", "''")}' AS ${quoteIdent("__source_type")}`;

    const sourceTables = schema
      .listConcreteTypesAssignableTo(source.sourceType)
      .map((candidate) => {
        const typeName = qualifiedTypeName(candidate);
        return {
          typeName,
          table: tableNameForType(typeName),
        };
      });

    const queryColumnsWithId = [...new Set(["id", ...queryColumns])];
    const polymorphicSource = sourceTables.length > 0
      ? (() => {
          const selects = sourceTables.map((entry) => {
            const tableInfo = db.prepare(`PRAGMA table_info(${quoteIdent(entry.table)})`).all() as Array<{ name?: unknown }>;
            const available = new Set(tableInfo.map((column) => String(column.name)).filter((name) => name.length > 0));
            const projected = queryColumnsWithId
              .map((column) =>
                available.has(column)
                  ? `${quoteIdent(column)} AS ${quoteIdent(column)}`
                  : `NULL AS ${quoteIdent(column)}`)
              .join(", ");
            return `SELECT '${entry.typeName.replaceAll("'", "''")}' AS ${quoteIdent("__source_type")}, ${projected} FROM ${quoteIdent(entry.table)}`;
          });
          return `(${selects.join(" UNION ALL ")}) t`;
        })()
      : `${quoteIdent(source.table)} t`;
    const sourceTypeSelect = sourceTables.length > 0
      ? `t.${quoteIdent("__source_type")} AS ${quoteIdent("__source_type")}`
      : sourceTypeSelectDefault;
    const selected = projected.length > 0 ? `${sourceTypeSelect}, ${projected}` : sourceTypeSelect;

    let sql = source.storage === "inline"
      ? `SELECT ${selected} FROM ${polymorphicSource} WHERE t.${quoteIdent(source.inlineColumn!)} = ?`
      : `SELECT ${selected} FROM ${polymorphicSource} JOIN ${quoteIdent(source.linkTable!)} l ON l.${quoteIdent("source")} = t.${quoteIdent("id")} WHERE l.${quoteIdent("target")} = ?`;

    if (nested.filter) {
      sql += ` AND ${compileNestedFilterExprSQL(nested.filter, params, source.storage === "table" ? "l" : undefined)}`;
    }

    sqlTrail.push({ sql, params: [...params], loweringMode: "fallback_multi_query" });
    const sourceRows = db.prepare(sql).all(...params) as Array<Record<string, unknown> & { __source_type?: unknown }>;

    for (const row of sourceRows) {
      const rowType = String(row.__source_type ?? source.sourceType);
      const key = `${rowType}:${String(row.id)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      rows.push({ ...row, __source_type: rowType });
    }
  }

  if (nested.orderBy) {
    const direction = nested.orderBy.direction === "desc" ? -1 : 1;
    const orderColumn = nested.orderBy.value;
    rows.sort((a, b) => {
      const left = a[orderColumn] as ScalarValue | undefined;
      const right = b[orderColumn] as ScalarValue | undefined;
      if (left === right) {
        return 0;
      }
      if (left === undefined || left === null) {
        return -1 * direction;
      }
      if (right === undefined || right === null) {
        return 1 * direction;
      }
      if (left < right) {
        return -1 * direction;
      }
      if (left > right) {
        return 1 * direction;
      }
      return 0;
    });
  }

  const offset = nested.offset ?? 0;
  const sliced = nested.limit === undefined
    ? rows.slice(offset)
    : rows.slice(offset, offset + nested.limit);

  return sliced.map((item) => materializeSelectRow(db, schema, context, nested.shape, item, rowSourceType(item, item.__source_type), sqlTrail));
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

const compileNestedFilterExprSQL = (filter: FilterExprIR, params: ScalarValue[], linkPropertyAlias?: string): string => {
  const columnExpr = (column: string): string => {
    if (column.startsWith("@")) {
      const alias = linkPropertyAlias ?? "t";
      return `${alias}.${quoteIdent(column.slice(1))}`;
    }
    if (column === "__type__.name") {
      return `t.${quoteIdent("__source_type")}`;
    }
    return `t.${quoteIdent(column)}`;
  };

  if (filter.kind === "field") {
    params.push(filter.value);
    return compileFilterPredicate(columnExpr(filter.column), filter.op);
  }

  if (filter.kind === "field_in") {
    const column = columnExpr(filter.column);
    const placeholders = filter.values.map(() => "?").join(", ");
    params.push(...filter.values);
    const op = filter.op === "in" ? "IN" : "NOT IN";
    return `${column} ${op} (${placeholders})`;
  }

  if (filter.kind === "field_compare") {
    const left = columnExpr(filter.leftColumn);
    const right = columnExpr(filter.rightColumn);
    if (filter.op === "=") {
      return `${left} = ${right}`;
    }
    if (filter.op === "!=") {
      return `${left} != ${right}`;
    }
    if (filter.op === "like") {
      return `${left} LIKE ${right}`;
    }
    return `LOWER(${left}) LIKE LOWER(${right})`;
  }

  if (filter.kind === "backlink") {
    throw new AppError("E_SQL", "Backlink filters are not supported for nested runtime link resolution");
  }

  if (filter.kind === "self_in_select") {
    throw new AppError("E_SQL", "IN subquery filters are not supported for nested runtime link resolution");
  }

  if (filter.kind === "backlink_contains") {
    throw new AppError("E_SQL", "Backlink membership filters are not supported for nested runtime link resolution");
  }

  if (filter.kind === "not") {
    return `(NOT ${compileNestedFilterExprSQL(filter.expr, params, linkPropertyAlias)})`;
  }

  const left = compileNestedFilterExprSQL(filter.left, params, linkPropertyAlias);
  const right = compileNestedFilterExprSQL(filter.right, params, linkPropertyAlias);
  return filter.kind === "and" ? `(${left} AND ${right})` : `(${left} OR ${right})`;
};

const compilePolymorphicTargetSource = (
  db: SQLiteDatabase,
  relation: LinkRelationIR,
  alias: string,
  requiredColumns: string[],
): string => {
  const targets = relation.targetTables.length > 0
    ? relation.targetTables
    : [{ name: relation.targetType, table: relation.targetTable }];

  const columns = [...new Set(["id", ...requiredColumns.filter((column) => column !== "__source_type")])];
  const tableColumns = new Map<string, Set<string>>();
  for (const target of targets) {
    const rows = db.prepare(`PRAGMA table_info(${quoteIdent(target.table)})`).all() as Array<{ name?: unknown }>;
    tableColumns.set(
      target.table,
      new Set(rows.map((row) => String(row.name)).filter((name) => name.length > 0)),
    );
  }

  const renderSelect = (target: (typeof targets)[number]): string => {
    const available = tableColumns.get(target.table) ?? new Set<string>();
    const projectedColumns = columns
      .map((column) =>
        available.has(column)
          ? `${quoteIdent(column)} AS ${quoteIdent(column)}`
          : `NULL AS ${quoteIdent(column)}`)
      .join(", ");
    return `SELECT '${target.name.replaceAll("'", "''")}' AS ${quoteIdent("__source_type")}, ${projectedColumns} FROM ${quoteIdent(target.table)}`;
  };

  if (targets.length === 1) {
    return `(${renderSelect(targets[0])}) ${alias}`;
  }

  const selects = targets.map((target) => renderSelect(target));
  return `(${selects.join(" UNION ALL ")}) ${alias}`;
};

const isScalarValue = (value: unknown): value is ScalarValue =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const isRecordRow = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parsePayloadArray = (value: unknown): unknown[] | null => {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }

    function decodeNested(input: unknown[]): unknown[];
    function decodeNested(input: unknown): unknown;
    function decodeNested(input: unknown): unknown {
      if (typeof input === "string") {
        const trimmed = input.trim();
        if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
          try {
            return decodeNested(JSON.parse(trimmed));
          } catch {
            return input;
          }
        }
        return input;
      }

      if (Array.isArray(input)) {
        return input.map((entry) => decodeNested(entry));
      }

      if (input && typeof input === "object") {
        return Object.fromEntries(Object.entries(input).map(([key, entry]) => [key, decodeNested(entry)]));
      }

      return input;
    }

    return decodeNested(parsed);
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

  if (ir.kind === "select_expr") {
    return [];
  }

  return ir.overlays;
};

const tableNameForType = (qualifiedName: string): string => qualifiedName.replaceAll("::", "__").toLowerCase();
const PENDING_INLINE_LINK_VALUE = "__gel_pending_inline_link__";
const PENDING_INSERT_REWRITE_VALUE = "__gel_pending_insert_rewrite__";

const normalizeLinkTargetNames = (targetType: string, moduleName: string): string[] =>
  targetType
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => (part.includes("::") ? part : `${moduleName}::${part}`));

const assignableTargetTablesForTargets = (
  schema: SchemaSnapshot,
  targetTypeNames: string[],
): Set<string> => {
  const tables = new Set<string>();
  for (const targetTypeName of targetTypeNames) {
    const assignable = schema.listConcreteTypesAssignableTo(targetTypeName);
    if (assignable.length > 0) {
      for (const candidate of assignable) {
        tables.add(tableNameForType(qualifiedTypeName(candidate)));
      }
      continue;
    }

    tables.add(tableNameForType(targetTypeName));
  }

  return tables;
};

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
    if (assignedId === PENDING_INLINE_LINK_VALUE) {
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

    const targetTypeNames = normalizeLinkTargetNames(link.targetType, typeDef.module ?? "default");
    const expectedTargetTables = assignableTargetTablesForTargets(schema, targetTypeNames);
    if (!expectedTargetTables.has(row.type_name)) {
      const expected = [...expectedTargetTables].sort().join(" or ");
      throw new AppError(
        "E_SEMANTIC",
        `Invalid id for link '${link.name}': expected '${expected}', got '${row.type_name}'`,
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

const typeDefForTable = (schema: SchemaSnapshot, table: string): TypeDef | undefined =>
  schema.listTypes().find((candidate) => tableNameForType(qualifiedTypeName(candidate)) === table);

const typeDefForInsertIR = (schema: SchemaSnapshot, table: string): TypeDef | undefined =>
  typeDefForTable(schema, table);

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
  const shape = expr.shape.length > 0 ? [...expr.shape] : [{ kind: "field", name: "id" } as const];
  const hasId = shape.some((element) => element.kind === "field" && element.name === "id");
  if (!hasId) {
    shape.unshift({ kind: "field", name: "id" });
  }
  const ast: SelectStatement = {
    kind: "select",
    with: expr.clauses._withBindings,
    withModule: expr.clauses._withModule,
    withModuleAliases: expr.clauses._withModuleAliases,
    typeName: expr.typeName,
    shape,
    fields: fieldsFromShape(shape),
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

const statementTypeOf = (statement: Statement): "select" | "insert" | "update" | "delete" => {
  if (statement.kind === "for") return statement.body.kind;
  return statement.kind === "select_free" || statement.kind === "select_expr" ? "select" : statement.kind;
};

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

  if (ast.kind === "update") {
    const readonlyFields = new Set(subjectType.fields.filter((field) => field.readonly).map((field) => field.name));
    const readonlyLinks = new Set((subjectType.links ?? []).filter((link) => link.readonly).map((link) => link.name));
    for (const fieldName of Object.keys(ast.values)) {
      if (readonlyFields.has(fieldName) || readonlyLinks.has(fieldName)) {
        throw new AppError("E_SEMANTIC", `cannot update read-only pointer '${fieldName}'`, ast.pos.line, ast.pos.column);
      }
    }
  }

  const applyPendingInsertDefaults = (values: Record<string, ScalarValue>): void => {
    for (const field of subjectType.fields) {
      if (!field.hasDefault) {
        continue;
      }
      if (values[field.name] !== PENDING_INSERT_REWRITE_VALUE) {
        continue;
      }

      const defaultExpr = field.defaultExpr;
      if (!defaultExpr) {
        continue;
      }

      if (defaultExpr.kind === "literal") {
        values[field.name] = defaultExpr.value;
        continue;
      }

      const evaluated = executeFunctionCall(schema, db, context, defaultExpr.name, defaultExpr.args as RuntimeFunctionArg[]);
      if (isScalarValue(evaluated)) {
        values[field.name] = evaluated;
        continue;
      }

      if (Array.isArray(evaluated) && evaluated.length > 0 && isScalarValue(evaluated[0])) {
        values[field.name] = evaluated[0] as ScalarValue;
      }
    }
  };

  const applyOnTargetDeletePolicies = (targetType: TypeDef, targetIds: string[], astPos: { line: number; column: number }): void => {
    if (targetIds.length === 0) {
      return;
    }

    const targetQualifiedName = qualifiedTypeName(targetType);

    const linkTargetsType = (link: NonNullable<TypeDef["links"]>[number], sourceModule: string): boolean => {
      const targets = normalizeLinkTargetNames(link.targetType, sourceModule);
      return targets.some((target) => {
        if (target === targetQualifiedName) {
          return true;
        }
        return schema.listConcreteTypesAssignableTo(target).some((candidate) => qualifiedTypeName(candidate) === targetQualifiedName);
      });
    };

    for (const sourceType of schema.listTypes()) {
      const sourceQualifiedName = qualifiedTypeName(sourceType);
      const sourceTable = tableNameForType(sourceQualifiedName);
      const sourceModule = sourceType.module ?? "default";

      for (const link of sourceType.links ?? []) {
        if (!link.onTargetDelete || !linkTargetsType(link, sourceModule)) {
          continue;
        }

        const usesLinkTable = Boolean(link.multi) || (link.properties?.length ?? 0) > 0;
        const sourceIds = new Set<string>();

        if (usesLinkTable) {
          const linkTable = `${sourceTable}__${link.name.toLowerCase()}`;
          const placeholders = targetIds.map(() => "?").join(", ");
          const rows = db
            .prepare(`SELECT ${quoteIdent("source")} AS ${quoteIdent("source")} FROM ${quoteIdent(linkTable)} WHERE ${quoteIdent("target")} IN (${placeholders})`)
            .all(...targetIds) as Array<{ source?: unknown }>;
          for (const row of rows) {
            if (typeof row.source === "string") {
              sourceIds.add(row.source);
            }
          }
        } else {
          const inlineColumn = `${link.name}_id`;
          const placeholders = targetIds.map(() => "?").join(", ");
          const rows = db
            .prepare(`SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(sourceTable)} WHERE ${quoteIdent(inlineColumn)} IN (${placeholders})`)
            .all(...targetIds) as Array<{ id?: unknown }>;
          for (const row of rows) {
            if (typeof row.id === "string") {
              sourceIds.add(row.id);
            }
          }
        }

        if (sourceIds.size === 0) {
          continue;
        }

        if (link.onTargetDelete === "restrict" || link.onTargetDelete === "deferred_restrict") {
          throw new AppError(
            "E_SEMANTIC",
            `deletion of '${targetQualifiedName}' is restricted by link '${sourceQualifiedName}.${link.name}'`,
            astPos.line,
            astPos.column,
          );
        }

        if (link.onTargetDelete === "delete_source") {
          const sourceIdList = [...sourceIds];
          const placeholders = sourceIdList.map(() => "?").join(", ");
          db.prepare(`DELETE FROM ${quoteIdent(sourceTable)} WHERE ${quoteIdent("id")} IN (${placeholders})`).run(...sourceIdList);
        }
      }
    }
  };

  db.prepare("BEGIN").run();
  try {
    if (ir.kind === "insert") {
      applyPendingInsertDefaults(ir.values);

      if (sqlArtifact.params.length > 0) {
        const keys = Object.keys(ir.values);
        sqlArtifact.params = keys.map((key) => {
          const value = ir.values[key];
          if (typeof value === "boolean") {
            return value ? 1 : 0;
          }
          return value;
        });
      }

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
      if (ast.kind === "update") {
        applyUpdateLinkAssignments(
          db,
          schema,
          ast,
          subjectType,
          preRows.map((row) => String(row.id)),
          context,
        );
      }
      const updatedRows = preRows.length > 0 ? readRowsByIds(db, ir.table, preRows.map((row) => String(row.id))) : [];
      enforceUpdateWritePolicies(subjectType, updatedRows, context, ast.pos.line, ast.pos.column);
      db.prepare("COMMIT").run();
      return { changes: writeResult.changes };
    }

    if (ir.kind === "delete") {
      const preRows = readTargetRowsForFilter(db, ir.table, ir.filter);
      enforceDeletePolicies(subjectType, preRows, context, ast.pos.line, ast.pos.column);
      applyOnTargetDeletePolicies(subjectType, preRows.map((row) => String(row.id)), ast.pos);
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

type LinkTargetAssignment = {
  id: string;
  properties: Record<string, ScalarValue>;
};

const resolveInsertTargets = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  value: InsertValue,
  context: SecurityContext,
  ast: InsertStatement,
): LinkTargetAssignment[] => {
  const resolveBinding = makeBindingResolver(ast, context, ast.pos.line, ast.pos.column);

  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return typeof value === "string" ? [{ id: value, properties: {} }] : [];
  }

  if (value.kind === "binding_ref") {
    const withValue = (ast.with ?? []).find((binding) => binding.name === value.name)?.value;
    if (withValue && withValue.kind === "subquery") {
      const rows = executeSelectExprRows(db, schema, withValue.query as Extract<InsertValue, { kind: "select" }>, context);
      return rows
        .map((row) => {
          if (typeof row.id !== "string") {
            return undefined;
          }

          const properties: Record<string, ScalarValue> = {};
          for (const [key, raw] of Object.entries(row)) {
            if (!key.startsWith("@")) {
              continue;
            }

            const scalar = coerceUnknownToScalar(raw);
            if (scalar === undefined) {
              continue;
            }
            properties[key] = scalar;
          }

          return { id: row.id, properties };
        })
        .filter((entry): entry is LinkTargetAssignment => !!entry);
    }

    const scalar = resolveBinding(value.name);
    return typeof scalar === "string" ? [{ id: scalar, properties: {} }] : [];
  }

  if (value.kind === "select") {
    const scopedSelect = {
      ...value,
      clauses: {
        ...value.clauses,
        _withBindings: value.clauses._withBindings ?? ast.with,
        _withModule: value.clauses._withModule ?? ast.withModule,
        _withModuleAliases: value.clauses._withModuleAliases ?? ast.withModuleAliases,
      },
    };
    const rows = executeSelectExprRows(db, schema, scopedSelect, context);
    return rows
      .map((row) => {
        if (typeof row.id !== "string") {
          return undefined;
        }

        const properties: Record<string, ScalarValue> = {};
        for (const [key, raw] of Object.entries(row)) {
          if (!key.startsWith("@")) {
            continue;
          }

          const scalar = coerceUnknownToScalar(raw);
          if (scalar === undefined) {
            continue;
          }
          properties[key] = scalar;
        }

        return { id: row.id, properties };
      })
      .filter((entry): entry is LinkTargetAssignment => !!entry);
  }

  if (value.kind === "insert") {
    return executeNestedInsert(db, schema, value, context).map((id) => ({ id, properties: {} }));
  }

  if (value.kind === "set") {
    return value.values.flatMap((item) => resolveInsertTargets(db, schema, item, context, ast));
  }

  if (value.kind === "for") {
    const iteratorValues = evaluateForIteratorValues(value.iteratorExpr, schema, db, context);
    const rows: LinkTargetAssignment[] = [];

    for (const iterValue of iteratorValues) {
      if (value.body.kind === "select") {
        const selectAst = ensureSelectAstHasId(bindSelectAstVariable(value.body, value.variable, iterValue));
        const compiler = getCompilerService();
        const compiled = compiler.compile(schema, selectAst, { globals: context.globals });
        assertTargetSqlCompatibility(compiled.sql.sql, resolvedRuntimeTarget(context, db));
        if (compiled.ir.kind !== "select") {
          continue;
        }

        const selectedRows = runSelectIR(db, schema, compiled.ir, context, compiled.sql, []);
        for (const row of selectedRows) {
          if (typeof row.id !== "string") {
            continue;
          }
          const properties: Record<string, ScalarValue> = {};
          for (const [key, raw] of Object.entries(row)) {
            if (!key.startsWith("@")) {
              continue;
            }

            const scalar = coerceUnknownToScalar(raw);
            if (scalar === undefined) {
              continue;
            }
            properties[key] = scalar;
          }
          rows.push({ id: row.id, properties });
        }
      } else {
        const replacedValues: Record<string, InsertValue> = {};
        for (const [field, insertValue] of Object.entries(value.body.values)) {
          if (typeof insertValue === "object" && insertValue !== null && "kind" in insertValue && insertValue.kind === "binding_ref" && insertValue.name === value.variable) {
            const scalar = coerceUnknownToScalar(iterValue);
            replacedValues[field] = scalar ?? insertValue;
          } else {
            replacedValues[field] = insertValue;
          }
        }

        const nestedIds = executeNestedInsert(db, schema, { kind: "insert", typeName: value.body.typeName, values: replacedValues }, context);
        rows.push(...nestedIds.map((id) => ({ id, properties: {} })));
      }
    }

    return rows;
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

  const defaultLinkPropertyValue = (property: NonNullable<NonNullable<TypeDef["links"]>[number]["properties"]>[number]): ScalarValue => {
    if (!property.hasDefault) {
      return null;
    }

    if (property.type === "int" || property.type === "float") {
      return Math.round(Math.random() * 10);
    }

    return null;
  };

  const resolveDefaultLinkAssignments = (
    link: NonNullable<TypeDef["links"]>[number],
  ): Array<{ id: string; properties: Record<string, ScalarValue> }> => {
    const targetQualified = normalizeLinkTargetNames(link.targetType, typeDef.module ?? "default")[0] ?? `${typeDef.module ?? "default"}::${link.targetType}`;
    const targetType = schema.getType(targetQualified);
    const targetTable = tableNameForType(targetQualified);

    const lookupColumn = targetType?.fields.some((field) => field.name === "val")
      ? "val"
      : targetType?.fields.some((field) => field.name === "name")
        ? "name"
        : undefined;

    if (link.defaultTargetValues && link.defaultTargetValues.length > 0 && lookupColumn) {
      return link.defaultTargetValues.flatMap((targetValue) => {
        const row = db
          .prepare(`SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(targetTable)} WHERE ${quoteIdent(lookupColumn)} = ? LIMIT 1`)
          .all(targetValue)[0] as { id?: unknown } | undefined;
        return typeof row?.id === "string" ? [{ id: row.id, properties: {} }] : [];
      });
    }

    const first = db
      .prepare(`SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(targetTable)} ORDER BY rowid ASC LIMIT 1`)
      .all()[0] as { id?: unknown } | undefined;
    if (typeof first?.id !== "string") {
      return [];
    }
    return [{ id: first.id, properties: {} }];
  };

  for (const [field, value] of Object.entries(ast.values)) {
    const link = linkByName.get(field);
    if (!link) {
      continue;
    }

    const targetAssignments = resolveInsertTargets(db, schema, value, context, ast);
    const targetIds = targetAssignments.map((assignment) => assignment.id);
    const linkOwner = resolveLinkStorageOwner(schema, typeDef, link);
    const ownerModule = linkOwner.module ?? "default";
    const targetTypeNames = normalizeLinkTargetNames(link.targetType, ownerModule);
    const assignableTargetTables = assignableTargetTablesForTargets(schema, targetTypeNames);
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
      const linkTable = `${tableNameForType(qualifiedTypeName(linkOwner))}__${link.name.toLowerCase()}`;
      const propertyDefs = link.properties ?? [];
      const propertyColumns = propertyDefs.map((property) => property.name);
      const propertyByName = new Map(propertyDefs.map((property) => [property.name, property] as const));
      const columns = ["source", "target", ...propertyColumns];
      const placeholders = columns.map(() => "?").join(", ");
      const insertSql = `INSERT INTO ${quoteIdent(linkTable)} (${columns.map(quoteIdent).join(", ")}) VALUES (${placeholders})`;

      for (const assignment of targetAssignments) {
        const params = [
          sourceId,
          assignment.id,
          ...propertyColumns.map((column) => {
            const explicit = assignment.properties[`@${column}`];
            if (explicit !== undefined) {
              return explicit;
            }
            const property = propertyByName.get(column);
            return property ? defaultLinkPropertyValue(property) : null;
          }),
        ];
        db
          .prepare(insertSql)
          .run(...params);
      }
      continue;
    }

    const inlineColumn = `${link.name}_id`;
    const targetId = targetIds[0] ?? null;
    db.prepare(`UPDATE ${quoteIdent(tableNameForType(qualifiedTypeName(typeDef)))} SET ${quoteIdent(inlineColumn)} = ? WHERE ${quoteIdent("id")} = ?`)
      .run(targetId, sourceId);
  }

  for (const link of typeDef.links ?? []) {
    if (Object.prototype.hasOwnProperty.call(ast.values, link.name)) {
      continue;
    }
    if (!link.hasDefault) {
      continue;
    }

    const assignments = resolveDefaultLinkAssignments(link);
    if (assignments.length === 0) {
      continue;
    }

    const usesLinkTable = Boolean(link.multi) || (link.properties?.length ?? 0) > 0;
    if (usesLinkTable) {
      const linkTable = `${tableNameForType(qualifiedTypeName(typeDef))}__${link.name.toLowerCase()}`;
      const propertyDefs = link.properties ?? [];
      const propertyColumns = propertyDefs.map((property) => property.name);
      const columns = ["source", "target", ...propertyColumns];
      const placeholders = columns.map(() => "?").join(", ");
      const insertSql = `INSERT INTO ${quoteIdent(linkTable)} (${columns.map(quoteIdent).join(", ")}) VALUES (${placeholders})`;

      for (const assignment of assignments) {
        const params = [
          sourceId,
          assignment.id,
          ...propertyDefs.map((property) => defaultLinkPropertyValue(property)),
        ];
        db.prepare(insertSql).run(...params);
      }
      continue;
    }

    const inlineColumn = `${link.name}_id`;
    db.prepare(`UPDATE ${quoteIdent(tableNameForType(qualifiedTypeName(typeDef)))} SET ${quoteIdent(inlineColumn)} = ? WHERE ${quoteIdent("id")} = ?`)
      .run(assignments[0]?.id ?? null, sourceId);
  }
};

const applyUpdateLinkAssignments = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: UpdateStatement,
  typeDef: TypeDef,
  sourceIds: string[],
  context: SecurityContext,
): void => {
  if (sourceIds.length === 0) {
    return;
  }

  const linkByName = new Map((typeDef.links ?? []).map((link) => [link.name, link] as const));

  for (const [field, value] of Object.entries(ast.values)) {
    const link = linkByName.get(field);
    if (!link) {
      continue;
    }

    const fauxInsertAst: InsertStatement = {
      kind: "insert",
      with: ast.with,
      withModule: ast.withModule,
      withModuleAliases: ast.withModuleAliases,
      typeName: ast.typeName,
      values: {},
      pos: ast.pos,
    };

    const targetAssignments = resolveInsertTargets(db, schema, value, context, fauxInsertAst);
    const targetIds = targetAssignments.map((assignment) => assignment.id);
    const linkOwner = resolveLinkStorageOwner(schema, typeDef, link);
    const ownerModule = linkOwner.module ?? "default";
    const targetTypeNames = normalizeLinkTargetNames(link.targetType, ownerModule);
    const assignableTargetTables = assignableTargetTablesForTargets(schema, targetTypeNames);
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
      const linkTable = `${tableNameForType(qualifiedTypeName(linkOwner))}__${link.name.toLowerCase()}`;
      const propertyColumns = (link.properties ?? []).map((property) => property.name);
      const columns = ["source", "target", ...propertyColumns];
      const placeholders = columns.map(() => "?").join(", ");
      const insertSql = `INSERT INTO ${quoteIdent(linkTable)} (${columns.map(quoteIdent).join(", ")}) VALUES (${placeholders})`;

      for (const sourceId of sourceIds) {
        db.prepare(`DELETE FROM ${quoteIdent(linkTable)} WHERE ${quoteIdent("source")} = ?`).run(sourceId);
        for (const assignment of targetAssignments) {
          const params = [
            sourceId,
            assignment.id,
            ...propertyColumns.map((column) => assignment.properties[`@${column}`] ?? null),
          ];
          db.prepare(insertSql).run(...params);
        }
      }
      continue;
    }

    const inlineColumn = `${link.name}_id`;
    const targetId = targetIds[0] ?? null;
    for (const sourceId of sourceIds) {
      db.prepare(`UPDATE ${quoteIdent(tableNameForType(qualifiedTypeName(typeDef)))} SET ${quoteIdent(inlineColumn)} = ? WHERE ${quoteIdent("id")} = ?`)
        .run(targetId, sourceId);
    }
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
    .all(id)[0];
  return row ?? null;
};
