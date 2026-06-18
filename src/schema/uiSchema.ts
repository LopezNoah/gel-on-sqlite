import type {
  AliasDef,
  AnnotationDef,
  FunctionDef,
  FunctionExprDef,
  ScalarValue,
  TypeDef,
} from "../types.js";
import type { FreeObjectExpr, SelectExprStatement, Statement } from "../edgeql/ast.js";
import { parseEdgeQL } from "../edgeql/parser.js";
import { tryResult } from "../errors.js";
import type { ComputedLinkPropertyExpr, DeclarativeSchema, FunctionDeclaration, LinkMember, LinkProperty, PropertyMember, TypeMember } from "./declarative.js";
import { AnnotationRegistry, AnnotationResolver, AnnotationSet } from "./annos.js";
import { SchemaSnapshot, qualifiedTypeName } from "./schema.js";
import { scalarTypeDeclarationToTypeDef } from "./scalar.js";
import { schemaIntrospectionTypeDefs } from "./schema_introspection.js";
import { TypeMemberResolver, cloneConstraints } from "./type_member_resolver.js";

const isStoredLinkProperty = (property: LinkMember["properties"][number]): property is LinkProperty =>
  property.computed !== true;

export const schemaSnapshotFromDeclarative = (schema: DeclarativeSchema): SchemaSnapshot => {
  const typeDefs = typeDefsFromDeclarative(schema);
  const scalarTypeDefs = scalarTypeDefsFromDeclarative(schema);
  return new SchemaSnapshot(
    [...typeDefs, ...scalarTypeDefs, ...schemaIntrospectionTypeDefs()],
    functionDefsFromDeclarative(schema),
    aliasDefsFromDeclarative(schema),
    schema.scalarTypes ?? [],
    (schema.globals ?? []).map((g) => ({ module: g.module, name: g.name, exprText: g.exprText })),
  );
};

export const aliasDefsFromDeclarative = (schema: DeclarativeSchema): AliasDef[] => {
  return (schema.aliases ?? []).map((alias) => ({
    module: alias.module,
    name: alias.name,
    exprText: alias.exprText,
    values: alias.values ? [...alias.values] : undefined,
    sourceType: alias.sourceType,
    projections: alias.projections
      ? alias.projections.map((projection) => ({
          name: projection.name,
          sourceField: projection.sourceField,
        }))
      : undefined,
    filter: alias.filter
      ? alias.filter.kind === "field_predicate"
        ? {
            kind: "field_predicate",
            field: alias.filter.field,
            op: alias.filter.op,
            value: alias.filter.value,
          }
        : {
            kind: "backlink_membership",
            op: alias.filter.op,
            value: alias.filter.value,
            link: alias.filter.link,
            sourceType: alias.filter.sourceType,
            field: alias.filter.field,
          }
      : undefined,
  }));
};

export const scalarTypeDefsFromDeclarative = (schema: DeclarativeSchema): TypeDef[] => {
  return (schema.scalarTypes ?? [])
    .filter((scalarType) => (scalarType.enumValues ?? []).length > 0)
    .map(scalarTypeDeclarationToTypeDef);
};

export const functionDefsFromDeclarative = (schema: DeclarativeSchema): FunctionDef[] => {
  return (schema.functions ?? []).map((fn) => ({
    module: fn.module,
    name: fn.name,
    params: fn.params.map((param) => ({ ...param })),
    returnType: normalizeTypeName(fn.returnType, fn.module),
    returnOptional: fn.returnOptional,
    returnSetOf: fn.returnSetOf,
    volatility: fn.volatility,
    annotations: fn.annotations.length ? fn.annotations.map((annotation) => ({ ...annotation })) : undefined,
    body: parseFunctionBody(fn),
  }));
};

export const typeDefsFromDeclarative = (schema: DeclarativeSchema): TypeDef[] => {
  const annotationRegistry = new AnnotationRegistry(schema.abstractAnnotations ?? []);
  const typeByName = new Map(schema.types.map((typeDecl) => [qualifiedTypeName(typeDecl), typeDecl]));

  const annotationResolver = new AnnotationResolver<DeclarativeSchema["types"][number]>(
    annotationRegistry,
    (typeDecl) => qualifiedTypeName(typeDecl),
    (name) => typeByName.get(name),
  );
  const memberResolver = new TypeMemberResolver(schema.types, annotationRegistry);

  const constraintAnnotations = new Map<string, AnnotationSet>();
  for (const constraint of schema.constraints ?? []) {
    constraintAnnotations.set(constraint.name, AnnotationSet.from(constraint.annotations));
  }

  const mergeConstraintAnnotations = (name: string, own: AnnotationDef[]): AnnotationDef[] => {
    const base = constraintAnnotations.get(name) ?? new AnnotationSet();
    return base.merge(AnnotationSet.from(own)).toArray();
  };

  const resolveTypeAnnotations = (typeDecl: DeclarativeSchema["types"][number]): AnnotationDef[] =>
    annotationResolver.resolve(typeDecl).toArray();

  return schema.types.map((typeDecl) => {
    const resolvedTypeAnnotations = resolveTypeAnnotations(typeDecl);
    const links: NonNullable<TypeDef["links"]> = [];
    const fields: TypeDef["fields"] = [];
    const computeds: NonNullable<TypeDef["computeds"]> = [];
    const mutationRewrites: NonNullable<TypeDef["mutationRewrites"]> = [];

    for (const member of memberResolver.resolveMembers(typeDecl)) {
      if (member.kind === "property") {
        const resolvedConstraints =
          member.constraints.length > 0
            ? member.constraints
                .map((constraint) => ({
                  name: constraint.name,
                  annotations: mergeConstraintAnnotations(constraint.name, constraint.annotations),
                  delegated: constraint.delegated,
                  params: constraint.params ? constraint.params.map((param) => ({ ...param })) : undefined,
                  onExpr: constraint.onExpr,
                  exceptExpr: constraint.exceptExpr,
                }))
            : [];

        fields.push({
          name: member.name,
          type: member.scalar,
          required: member.required,
          hasDefault: member.hasDefault,
          defaultExpr: member.defaultExpr ? { ...member.defaultExpr, ...(member.defaultExpr.kind === "function_call" ? { args: [...member.defaultExpr.args] } : {}) } : undefined,
          defaultExprText: member.defaultExprText,
          readonly: member.readonly,
          multi: member.multi,
          collection: member.collection,
          annotations: (member.annotations ?? []).length ? [...member.annotations] : undefined,
          constraints: resolvedConstraints,
          targetTypeName: member.targetTypeName,
          enumValues: member.enumValues,
          enumTypeName: member.enumTypeName,
          splatStrategy: member.splatStrategy,
        });

        if (!member.multi && (member.rewrite?.onInsert || member.rewrite?.onUpdate)) {
          mutationRewrites.push({
            field: member.name,
            onInsert: member.rewrite.onInsert,
            onUpdate: member.rewrite.onUpdate,
          });
        }
        continue;
      }

      if (member.kind === "computed") {
        if (member.computedKind === "property") {
          if (member.expr.kind === "field_ref") {
            computeds.push({
              kind: "property",
              name: member.name,
              required: member.required,
              multi: member.multi,
              annotations: member.annotations.length ? [...member.annotations] : undefined,
              expr: {
                kind: "field_ref",
                field: member.expr.field,
              },
            });
          } else if (member.expr.kind === "literal") {
            computeds.push({
              kind: "property",
              name: member.name,
              required: member.required,
              multi: member.multi,
              annotations: member.annotations.length ? [...member.annotations] : undefined,
              expr: {
                kind: "literal",
                value: member.expr.value,
              },
            });
          } else if (member.expr.kind === "set_literal") {
            computeds.push({
              kind: "property",
              name: member.name,
              required: member.required,
              multi: member.multi,
              annotations: member.annotations.length ? [...member.annotations] : undefined,
              expr: {
                kind: "set_literal",
                values: [...member.expr.values],
              },
            });
          } else if (member.expr.kind === "concat") {
            computeds.push({
              kind: "property",
              name: member.name,
              required: member.required,
              multi: member.multi,
              annotations: member.annotations.length ? [...member.annotations] : undefined,
              expr: {
                kind: "concat",
                parts: member.expr.parts.map((part) => ({ ...part })),
              },
            });
          } else if (member.expr.kind === "function_call") {
            computeds.push({
              kind: "property",
              name: member.name,
              required: member.required,
              multi: member.multi,
              annotations: member.annotations.length ? [...member.annotations] : undefined,
              expr: {
                kind: "function_call",
                name: member.expr.name,
                args: [...member.expr.args],
              },
            });
          } else if (member.expr.kind === "link_aggregate") {
            computeds.push({
              kind: "property",
              name: member.name,
              required: member.required,
              multi: member.multi,
              annotations: member.annotations.length ? [...member.annotations] : undefined,
              expr: {
                kind: "link_aggregate",
                functionName: member.expr.functionName,
                link: member.expr.link,
                field: member.expr.field,
              },
            });
          } else if (member.expr.kind === "edgeql_expr") {
            computeds.push({
              kind: "property",
              name: member.name,
              required: member.required,
              multi: member.multi,
              annotations: member.annotations.length ? [...member.annotations] : undefined,
              expr: {
                kind: "edgeql_expr",
                exprText: member.expr.exprText,
              },
            });
          } else {
            throw new Error(`Computed '${member.name}' has invalid property expression kind '${(member.expr as { kind: string }).kind}'`);
          }
        } else {
          if (member.expr.kind === "backlink") {
            computeds.push({
              kind: "link",
              name: member.name,
              required: member.required,
              multi: member.multi,
              annotations: member.annotations.length ? [...member.annotations] : undefined,
              expr: {
                kind: "backlink",
                link: member.expr.link,
                sourceType: member.expr.sourceType
                  ? normalizeTypeName(member.expr.sourceType, typeDecl.module)
                  : undefined,
              },
            });
          } else if (member.expr.kind === "link_ref") {
            computeds.push({
              kind: "link",
              name: member.name,
              required: member.required,
              multi: member.multi,
              annotations: member.annotations.length ? [...member.annotations] : undefined,
              expr: {
                kind: "link_ref",
                link: member.expr.link,
                filter: member.expr.filter ? { ...member.expr.filter } : undefined,
              },
            });
          } else if (member.expr.kind === "select_type") {
            computeds.push({
              kind: "link",
              name: member.name,
              required: member.required,
              multi: member.multi,
              annotations: member.annotations.length ? [...member.annotations] : undefined,
              expr: {
                kind: "select_type",
                typeName: normalizeTypeName(member.expr.typeName, typeDecl.module),
                exprText: member.expr.exprText,
              },
            });
          } else {
            throw new Error(`Computed '${member.name}' has invalid link expression kind '${member.expr.kind}'`);
          }
        }
        continue;
      }

      const storedProperties = member.properties.filter(isStoredLinkProperty);
      const computedProperties = member.properties.filter((property) => property.computed === true);
      links.push({
        name: member.name,
        targetType: normalizeTypeName(member.target, typeDecl.module),
        overloaded: member.overloaded,
        required: member.required,
        multi: member.multi,
        readonly: member.readonly,
        onTargetDelete: member.onTargetDelete,
        properties: storedProperties.length
          ? storedProperties.map((property) => ({
              name: property.name,
              type: property.scalar,
              required: property.required,
              hasDefault: property.hasDefault,
              defaultExpr: property.defaultExpr,
              readonly: property.readonly,
              collection: property.collection,
              defaultExprText: property.defaultExprText,
              annotations: property.annotations.length ? [...property.annotations] : undefined,
            }))
          : undefined,
        computedProperties: computedProperties.length
          ? computedProperties.map((property) => ({
              name: property.name,
              exprText: property.exprText,
              computedExpr: property.computedExpr,
              annotations: property.annotations.length ? [...property.annotations] : undefined,
            }))
          : undefined,
        hasDefault: member.hasDefault,
        defaultTargetValues: member.defaultTargetValues ? [...member.defaultTargetValues] : undefined,
        defaultTargetFilter: member.defaultTargetFilter ? { column: member.defaultTargetFilter.column, values: [...member.defaultTargetFilter.values] } : undefined,
        defaultExprText: member.defaultExprText,
        annotations: (member.annotations ?? []).length ? [...member.annotations] : undefined,
        constraints: (member.constraints ?? []).length ? [...(member.constraints ?? [])] : undefined,
        splatStrategy: member.splatStrategy,
      });

      if (!member.multi && storedProperties.length === 0) {
        fields.push({
          name: `${member.name}_id`,
          type: "uuid",
          required: false,
          hasDefault: member.hasDefault,
          isLinkColumn: true,
        });
      }
    }

    return {
      module: typeDecl.module,
      name: typeDecl.name,
      abstract: typeDecl.abstract,
      extends: (typeDecl.extends ?? []).length ? [...typeDecl.extends] : undefined,
      annotations: resolvedTypeAnnotations.length ? resolvedTypeAnnotations : undefined,
      indexes: (typeDecl.indexes ?? []).length ? (typeDecl.indexes ?? []).map((index) => ({ ...index })) : undefined,
      fields,
      links: links.length ? links : undefined,
      computeds: computeds.length ? computeds : undefined,
      mutationRewrites: mutationRewrites.length ? mutationRewrites : undefined,
      triggers: typeDecl.triggers.length ? [...typeDecl.triggers] : undefined,
      accessPolicies: typeDecl.accessPolicies.length ? [...typeDecl.accessPolicies] : undefined,
      typeConstraints: (typeDecl.typeConstraints ?? []).length
        ? (typeDecl.typeConstraints ?? []).map((c) => ({ ...c, fieldRefs: [...c.fieldRefs], delegated: c.delegated }))
        : undefined,
    };
  });
};

export const declarativeSchemaFromTypeDefs = (types: TypeDef[], functions: FunctionDef[] = []): DeclarativeSchema => {
  const modules = new Set<string>();
  const grouped = new Map<string, TypeDef[]>();
  const functionGroups = new Map<string, FunctionDef[]>();

  for (const typeDef of types) {
    const moduleName = typeDef.module ?? "default";
    modules.add(moduleName);
    const list = grouped.get(moduleName) ?? [];
    list.push(typeDef);
    grouped.set(moduleName, list);
  }

  for (const fn of functions) {
    modules.add(fn.module);
    const list = functionGroups.get(fn.module) ?? [];
    list.push(fn);
    functionGroups.set(fn.module, list);
  }

  return {
    modules: [...modules].sort().map((name) => ({ name })),
    abstractAnnotations: [],
    permissions: [],
    functions: [...functionGroups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([, moduleFunctions]) =>
        [...moduleFunctions]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((fn) => ({
            module: fn.module,
            name: fn.name,
            params: fn.params.map((param) => ({ ...param })),
            returnType: shortTypeName(fn.returnType, fn.module),
            returnOptional: Boolean(fn.returnOptional),
            returnSetOf: Boolean(fn.returnSetOf),
            volatility: fn.volatility,
            annotations: [...(fn.annotations ?? [])],
            body:
              fn.body.kind === "query"
                ? { language: "edgeql" as const, text: fn.body.query }
                : { language: "edgeql" as const, text: renderFunctionExpr(fn.body.expr) },
          })),
      ),
    types: [...grouped.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([moduleName, moduleTypes]) =>
        [...moduleTypes]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((typeDef) => {
            const fieldByName = new Map(typeDef.fields.map((field) => [field.name, field]));
            const consumedFields = new Set<string>();
            const members: TypeMember[] = [];

            for (const link of typeDef.links ?? []) {
              const idFieldName = `${link.name}_id`;
              const idField = fieldByName.get(idFieldName);
              if (idField) {
                consumedFields.add(idFieldName);
              }

              const linkMember: LinkMember = {
                kind: "link",
                name: link.name,
                target: normalizeTypeName(link.targetType, moduleName),
                required: Boolean(idField?.required),
                hasDefault: Boolean(idField?.hasDefault),
                readonly: Boolean(link.readonly),
                onTargetDelete: link.onTargetDelete,
                multi: Boolean(link.multi),
                overloaded: Boolean(link.overloaded),
                annotations: [...(link.annotations ?? [])],
                properties: [
                  ...(link.properties ?? []).map((property) => ({
                    name: property.name,
                    scalar: property.type,
                    required: Boolean(property.required),
                    collection: property.collection,
                    readonly: Boolean(property.readonly),
                    annotations: [...(property.annotations ?? [])],
                  })),
                  ...(link.computedProperties ?? []).map((property) => ({
                    name: property.name,
                    computed: true as const,
                    exprText: property.exprText,
                    computedExpr: property.computedExpr,
                    annotations: [...(property.annotations ?? [])],
                  })),
                ],
              };

              members.push(linkMember);
            }

            for (const field of typeDef.fields) {
              if (field.name === "id" || consumedFields.has(field.name)) {
                continue;
              }

              const rewrite = typeDef.mutationRewrites?.find((candidate) => candidate.field === field.name);

              const fieldConstraints = field.constraints ? cloneConstraints(field.constraints) : [];

              const member: PropertyMember = {
                kind: "property",
                name: field.name,
                scalar: field.type,
                required: Boolean(field.required),
                hasDefault: Boolean(field.hasDefault),
                defaultExpr: field.defaultExpr
                  ? field.defaultExpr.kind === "function_call"
                    ? { kind: "function_call", name: field.defaultExpr.name, args: [...field.defaultExpr.args] }
                    : { kind: "literal", value: field.defaultExpr.value }
                  : undefined,
                readonly: Boolean(field.readonly),
                multi: Boolean(field.multi),
                overloaded: false,
                annotations: [...(field.annotations ?? [])],
                targetTypeName: field.targetTypeName,
                constraints: fieldConstraints,
                rewrite: rewrite
                  ? {
                      onInsert: rewrite.onInsert,
                      onUpdate: rewrite.onUpdate,
                    }
                  : undefined,
              };
              members.push(member);
            }

            for (const computed of typeDef.computeds ?? []) {
              const computedMember: TypeMember = {
                kind: "computed",
                name: computed.name,
                required: Boolean(computed.required),
                multi: Boolean(computed.multi),
                overloaded: false,
                annotations: [...(computed.annotations ?? [])],
                computedKind: computed.kind,
                expr:
                  computed.kind === "property"
                    ? computed.expr.kind === "concat"
                      ? {
                          kind: "concat",
                          parts: computed.expr.parts.map((part) => ({ ...part })),
                        }
                      : { ...computed.expr }
                    : computed.expr.kind === "backlink"
                      ? {
                          kind: "backlink",
                          link: computed.expr.link,
                          sourceType: computed.expr.sourceType,
                        }
                      : computed.expr.kind === "select_type"
                        ? { ...computed.expr }
                        : {
                          kind: "link_ref",
                          link: computed.expr.link,
                          filter: computed.expr.filter ? { ...computed.expr.filter } : undefined,
                        },
              };
              members.push(computedMember);
            }

            return {
              kind: "object" as const,
              module: moduleName,
              name: typeDef.name,
              abstract: Boolean(typeDef.abstract),
              extends: [...(typeDef.extends ?? [])],
              annotations: [...(typeDef.annotations ?? [])],
              indexes: [...(typeDef.indexes ?? [])],
              members: members.sort((a, b) => a.name.localeCompare(b.name)),
              triggers: [...(typeDef.triggers ?? [])],
              accessPolicies: [...(typeDef.accessPolicies ?? [])],
            };
          }),
      ),
  };
};

export const renderDeclarativeSchema = (schema: DeclarativeSchema): string => {
  const lines: string[] = [];
  const typesByModule = new Map<string, DeclarativeSchema["types"]>();
  const annotationsByModule = new Map<string, NonNullable<DeclarativeSchema["abstractAnnotations"]>>();
  const functionsByModule = new Map<string, NonNullable<DeclarativeSchema["functions"]>>();
  for (const typeDecl of schema.types) {
    const list = typesByModule.get(typeDecl.module) ?? [];
    list.push(typeDecl);
    typesByModule.set(typeDecl.module, list);
  }

  for (const abstractAnnotation of schema.abstractAnnotations ?? []) {
    const list = annotationsByModule.get(abstractAnnotation.module) ?? [];
    list.push(abstractAnnotation);
    annotationsByModule.set(abstractAnnotation.module, list);
  }

  for (const fn of schema.functions ?? []) {
    const list = functionsByModule.get(fn.module) ?? [];
    list.push(fn);
    functionsByModule.set(fn.module, list);
  }

  const moduleNames = [
    ...new Set([...schema.modules.map((m) => m.name), ...typesByModule.keys(), ...annotationsByModule.keys(), ...functionsByModule.keys()]),
  ].sort();

  for (const moduleName of moduleNames) {
    lines.push(`module ${moduleName} {`);
    const moduleTypes = [...(typesByModule.get(moduleName) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    const moduleAnnotations = [...(annotationsByModule.get(moduleName) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    const moduleFunctions = [...(functionsByModule.get(moduleName) ?? [])].sort((a, b) => a.name.localeCompare(b.name));

    const modulePermissions = (schema.permissions ?? [])
      .filter((permission) => permission.module === moduleName)
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const permission of modulePermissions) {
      lines.push(`  permission ${permission.name};`);
    }

    for (const abstractAnnotation of moduleAnnotations) {
      const prefix = `abstract ${abstractAnnotation.inheritable ? "inheritable " : ""}annotation`;
      if (abstractAnnotation.annotations.length === 0) {
        lines.push(`  ${prefix} ${shortTypeName(abstractAnnotation.name, moduleName)};`);
        continue;
      }

      lines.push(`  ${prefix} ${shortTypeName(abstractAnnotation.name, moduleName)} {`);
      for (const annotation of abstractAnnotation.annotations) {
        lines.push(`    annotation ${shortTypeName(annotation.name, moduleName)} := ${quoteString(annotation.value)};`);
      }
      lines.push("  };");
    }

    if ((modulePermissions.length > 0 || moduleAnnotations.length > 0) && (moduleTypes.length > 0 || moduleFunctions.length > 0)) {
      lines.push("");
    }

    for (const fn of moduleFunctions) {
      const args = fn.params
        .map((param) => {
          const kind = `${param.namedOnly ? "named only " : ""}${param.variadic ? "variadic " : ""}`;
          const typeQual = `${param.optional ? "optional " : ""}${param.setOf ? "set of " : ""}`;
          const defaultValue = param.default === undefined ? "" : ` = ${renderScalarLiteral(param.default)}`;
          return `${kind}${param.name}: ${typeQual}${shortTypeName(param.type, moduleName)}${defaultValue}`;
        })
        .join(", ");
      const returnQual = `${fn.returnOptional ? "optional " : ""}${fn.returnSetOf ? "set of " : ""}`;
      lines.push(
        `  function ${fn.name}(${args}) -> ${returnQual}${shortTypeName(fn.returnType, moduleName)} using (${fn.body.text});`,
      );
    }

    if (moduleFunctions.length > 0 && moduleTypes.length > 0) {
      lines.push("");
    }

    for (const typeDecl of moduleTypes) {
      const typeHead = `${typeDecl.abstract ? "abstract " : ""}type ${typeDecl.name}`;
      const extendsClause = (typeDecl.extends ?? []).length ? ` extending ${typeDecl.extends.join(", ")}` : "";
      lines.push(`  ${typeHead}${extendsClause} {`);

      for (const annotation of typeDecl.annotations ?? []) {
        lines.push(`    annotation ${shortTypeName(annotation.name, moduleName)} := ${quoteString(annotation.value)};`);
      }

      for (const member of typeDecl.members) {
        const prefix = `${member.overloaded ? "overloaded " : ""}${member.required ? "required " : ""}${member.multi ? "multi " : ""}`;
        if (member.kind === "property") {
          if (!member.rewrite?.onInsert && !member.rewrite?.onUpdate && (member.annotations ?? []).length === 0) {
            lines.push(`    ${prefix}${member.name}: ${member.scalar};`);
            continue;
          }

          lines.push(`    ${prefix}${member.name}: ${member.scalar} {`);
          for (const annotation of member.annotations ?? []) {
            lines.push(`      annotation ${shortTypeName(annotation.name, moduleName)} := ${quoteString(annotation.value)};`);
          }
          const rewriteOnInsert = member.rewrite?.onInsert;
          const rewriteOnUpdate = member.rewrite?.onUpdate;
          if (rewriteOnInsert && rewriteOnUpdate) {
            const expr = renderMutationRewriteExpr(rewriteOnInsert);
            if (expr === renderMutationRewriteExpr(rewriteOnUpdate)) {
              lines.push(`      rewrite insert, update using (${expr});`);
            } else {
              lines.push(`      rewrite insert using (${renderMutationRewriteExpr(rewriteOnInsert)});`);
              lines.push(`      rewrite update using (${renderMutationRewriteExpr(rewriteOnUpdate)});`);
            }
          } else if (rewriteOnInsert) {
            lines.push(`      rewrite insert using (${renderMutationRewriteExpr(rewriteOnInsert)});`);
          } else if (rewriteOnUpdate) {
            lines.push(`      rewrite update using (${renderMutationRewriteExpr(rewriteOnUpdate)});`);
          }
          lines.push("    };");
          continue;
        }

        if (member.kind === "computed") {
          const computedExpr = renderComputedExpr(member.expr, moduleName);
          if ((member.annotations ?? []).length === 0) {
            lines.push(`    ${prefix}${member.name} := ${computedExpr};`);
            continue;
          }

          lines.push(`    ${prefix}${member.name} := ${computedExpr} {`);
          for (const annotation of member.annotations ?? []) {
            lines.push(`      annotation ${shortTypeName(annotation.name, moduleName)} := ${quoteString(annotation.value)};`);
          }
          lines.push("    };");
          continue;
        }

        if (member.properties.length === 0 && (member.annotations ?? []).length === 0) {
          lines.push(`    ${prefix}${member.name}: ${shortTypeName(member.target, moduleName)};`);
          continue;
        }

        lines.push(`    ${prefix}${member.name}: ${shortTypeName(member.target, moduleName)} {`);
        for (const annotation of member.annotations ?? []) {
          lines.push(`      annotation ${shortTypeName(annotation.name, moduleName)} := ${quoteString(annotation.value)};`);
        }
        for (const linkProperty of member.properties) {
          if (linkProperty.computed === true) {
            lines.push(`      ${linkProperty.name} := ${renderComputedLinkPropertyExpr(linkProperty.computedExpr)};`);
            continue;
          }

          if ((linkProperty.annotations ?? []).length === 0) {
            lines.push(`      ${linkProperty.required ? "required " : ""}${linkProperty.name}: ${linkProperty.scalar};`);
            continue;
          }

          lines.push(`      ${linkProperty.required ? "required " : ""}${linkProperty.name}: ${linkProperty.scalar} {`);
          for (const annotation of linkProperty.annotations ?? []) {
            lines.push(`        annotation ${shortTypeName(annotation.name, moduleName)} := ${quoteString(annotation.value)};`);
          }
          lines.push("      };");
        }
        lines.push("    };");
      }

      for (const index of typeDecl.indexes ?? []) {
        lines.push(`    index on (${index.expr});`);
      }

      for (const trigger of typeDecl.triggers) {
        const whenClause =
          trigger.when?.kind === "field_changed"
            ? ` when (__old__.${trigger.when.field} != __new__.${trigger.when.field})`
            : "";
        const action = trigger.actions[0];
        if (action) {
          const assignments = Object.entries(action.values)
            .map(([field, expr]) => `${field} := ${renderTriggerValueExpr(expr)}`)
            .join(", ");
          lines.push(
            `    trigger ${trigger.name} after ${trigger.event} for ${trigger.scope ?? "each"}${whenClause} do (insert ${shortTypeName(action.targetType, moduleName)} { ${assignments} });`,
          );
        }
      }

      for (const policy of typeDecl.accessPolicies) {
        const operationList = renderPolicyOperations(policy.operations);
        // Prefer the original `USING (...)` source text (round-trips arbitrary
        // predicates verbatim); fall back to the structured condition.
        const usingClause = policy.usingExprText ?? renderPolicyCondition(policy.condition, moduleName);
        lines.push(
          `    access policy ${policy.name} ${policy.effect} ${operationList} using (${usingClause});`,
        );
      }

      lines.push("  }");
      lines.push("");
    }

    if (lines[lines.length - 1] === "") {
      lines.pop();
    }

    lines.push("}");
    lines.push("");
  }

  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines.join("\n");
};

export const renderDeclarativeSchemaFromSnapshot = (schema: SchemaSnapshot): string => {
  return renderDeclarativeSchema(declarativeSchemaFromTypeDefs(schema.listTypes(), schema.listFunctions()));
};

const quoteString = (value: string): string => `'${value.replaceAll("'", "\\'")}'`;

const renderComputedExpr = (expr: Extract<TypeMember, { kind: "computed" }>['expr'], moduleName: string): string => {
  if (expr.kind === "field_ref") {
    return `.${expr.field}`;
  }

  if (expr.kind === "literal") {
    return renderScalarLiteral(expr.value);
  }

  if (expr.kind === "set_literal") {
    return `{${expr.values.map((value) => renderScalarLiteral(value)).join(", ")}}`;
  }

  if (expr.kind === "concat") {
    return expr.parts
      .map((part) => (part.kind === "field_ref" ? `.${part.field}` : renderScalarLiteral(part.value)))
      .join(" ++ ");
  }

  if (expr.kind === "function_call") {
    const args = expr.args.map((arg) => renderScalarLiteral(arg)).join(", ");
    return `${expr.name}(${args})`;
  }

  if (expr.kind === "link_aggregate") {
    return `${expr.functionName}(.${expr.link}.${expr.field})`;
  }

  if (expr.kind === "backlink") {
    const source = expr.sourceType ? `[is ${shortTypeName(expr.sourceType, moduleName)}]` : "";
    return `.<${expr.link}${source}`;
  }

  if (expr.kind === "select_type") {
    return expr.exprText;
  }

  if (expr.kind === "edgeql_expr") {
    return expr.exprText;
  }

  if (!expr.filter) {
    return `(select .${expr.link})`;
  }

  const op = expr.filter.op;
  return `(select .${expr.link} filter .${expr.filter.field} ${op} ${renderScalarLiteral(expr.filter.value)})`;
};

const renderComputedLinkPropertyExpr = (expr: ComputedLinkPropertyExpr): string => {
  if (expr.kind === "field_ref") {
    return `.${expr.name}`;
  }
  if (expr.kind === "link_property_ref") {
    return `@${expr.name}`;
  }
  if (expr.kind === "literal") {
    return renderScalarLiteral(expr.value);
  }

  const left = expr.left.kind === "binary_op" ? `(${renderComputedLinkPropertyExpr(expr.left)})` : renderComputedLinkPropertyExpr(expr.left);
  const right = expr.right.kind === "binary_op" ? `(${renderComputedLinkPropertyExpr(expr.right)})` : renderComputedLinkPropertyExpr(expr.right);
  return `${left} ${expr.op} ${right}`;
};

const normalizeTypeName = (name: string, moduleName: string): string => {
  if (name.includes("|")) {
    return name
      .split("|")
      .map((part) => normalizeTypeName(part.trim(), moduleName))
      .join("|");
  }

  if (name.includes("::")) {
    return name;
  }
  return `${moduleName}::${name}`;
};

const shortTypeName = (name: string, moduleName: string): string => {
  if (name.includes("|")) {
    return name
      .split("|")
      .map((part) => shortTypeName(part.trim(), moduleName))
      .join(" | ");
  }

  const [targetModule, targetName] = name.includes("::") ? name.split("::") : [moduleName, name];
  if (targetModule === moduleName) {
    return targetName;
  }
  return `${targetModule}::${targetName}`;
};

const renderMutationRewriteExpr = (expr: NonNullable<PropertyMember["rewrite"]>["onInsert"]): string => {
  if (!expr) {
    return "{}";
  }

  if (expr.kind === "datetime_of_statement") {
    return "datetime_of_statement()";
  }

  if (expr.kind === "subject_field") {
    return `.${expr.field}`;
  }

  if (expr.kind === "old_field") {
    return `__old__.${expr.field}`;
  }

  return renderScalarLiteral(expr.value);
};

const renderTriggerValueExpr = (expr: { kind: string; field?: string; value?: unknown }): string => {
  if (expr.kind === "new_field") {
    return `__new__.${expr.field}`;
  }

  if (expr.kind === "old_field") {
    return `__old__.${expr.field}`;
  }

  return renderScalarLiteral(expr.value);
};

const renderPolicyOperations = (operations: string[]): string => {
  if (operations.includes("all")) {
    return "all";
  }

  const labels = operations.map((op) => {
    if (op === "update_read") {
      return "update read";
    }
    if (op === "update_write") {
      return "update write";
    }
    return op;
  });
  return labels.join(", ");
};

const renderPolicyCondition = (condition: { kind: string; [key: string]: unknown }, moduleName: string): string => {
  if (condition.kind === "always") {
    return condition.value ? "true" : "false";
  }

  if (condition.kind === "global") {
    const value = String(condition.name);
    const [left, right] = value.includes("::") ? value.split("::") : [moduleName, value];
    return `global ${left === moduleName ? right : value}`;
  }

  if (condition.kind === "field_eq_global") {
    const field = String(condition.field);
    const globalName = String(condition.global);
    return `.${field} ?= global ${globalName}`;
  }

  if (condition.kind === "field_eq_literal") {
    return `.${String(condition.field)} = ${renderScalarLiteral(condition.value)}`;
  }

  if (condition.kind === "and") {
    const clauses = Array.isArray(condition.clauses) ? condition.clauses : [];
    return clauses.map((clause) => renderPolicyCondition(clause as { kind: string }, moduleName)).join(" and ");
  }

  return "false";
};

const parseFunctionBody = (fn: FunctionDeclaration): FunctionDef["body"] => {
  const trimmed = fn.body.text.trim();
  const paramNames = new Set(fn.params.map((param) => param.name));
  const statement = parseFunctionStatement(trimmed);
  if (statement?.kind === "select_expr" && !statement.with && statement.expr.kind === "concat"
    && concatRoundtripsAsExprBody(statement.expr, paramNames)) {
    return {
      kind: "expr",
      expr: astToFunctionExpr(statement.expr, paramNames),
    };
  }

  if (isQueryStatement(statement)) {
    return {
      kind: "query",
      language: fn.body.language,
      query: trimmed,
    };
  }

  // If the body is a bare expression (e.g. `x ?? -1`), the simple-expr path
  // only round-trips param_ref/literal/concat — anything else (coalesce,
  // math, function calls, …) gets degraded to `""` by the AST→FunctionExpr
  // fallback. Route those through the query path with a `select` prefix so
  // the full evaluator handles them.
  const wrappedStatement = parseFunctionStatement(`select ${trimmed}`);
  if (wrappedStatement?.kind === "select_expr"
    && !wrappedStatement.with
    && wrappedStatement.expr.kind !== "concat") {
    return {
      kind: "query",
      language: fn.body.language,
      query: `select ${trimmed}`,
    };
  }

  return {
    kind: "expr",
    expr: parseFunctionExpr(trimmed, paramNames),
  };
};

const parseFunctionExpr = (source: string, paramNames: Set<string>): FunctionExprDef => {
  const statement = parseFunctionStatement(`select ${source}`);
  if (statement?.kind === "select_expr") {
    return astToFunctionExpr(statement.expr, paramNames);
  }

  return {
    kind: "literal",
    value: parseFunctionLiteral(source),
  };
};

const parseFunctionStatement = (source: string): Statement | undefined => {
  // Probe: callers fall back to literal/expr handling when the body isn't
  // a parsable statement. Non-syntax errors (engine bugs) propagate.
  const parsed = tryResult(() => parseEdgeQL(source));
  return parsed.ok ? parsed.value : undefined;
};

const isQueryStatement = (statement: Statement | undefined): boolean => {
  return statement?.kind === "select"
    || statement?.kind === "select_expr"
    || statement?.kind === "select_free"
    || statement?.kind === "insert"
    || statement?.kind === "update"
    || statement?.kind === "delete"
    || statement?.kind === "for";
};

// True when a `concat` expression can be losslessly represented as an `expr`
// function body. The simple `expr` form only carries `literal`s and
// `param_ref`s; richer forms (casts, function calls, math, etc.) get silently
// degraded by `astToFunctionExprPart` and must go through the `query` body
// path so the full pipeline can lower them.
const concatRoundtripsAsExprBody = (
  expr: FreeObjectExpr,
  paramNames: Set<string>,
): boolean => {
  if (expr.kind === "concat") {
    return expr.parts.every((part) => concatRoundtripsAsExprBody(part, paramNames));
  }
  if (expr.kind === "literal") return true;
  if (expr.kind === "binding_ref") return paramNames.has(expr.name);
  return false;
};

const astToFunctionExpr = (
  expr: SelectExprStatement["expr"],
  paramNames: Set<string>,
): FunctionExprDef => {
  if (expr.kind === "concat") {
    return {
      kind: "concat",
      parts: expr.parts.flatMap((part) => astToFunctionExprParts(part, paramNames)),
    };
  }

  const part = astToFunctionExprPart(expr, paramNames);
  return part;
};

const astToFunctionExprParts = (
  expr: FreeObjectExpr,
  paramNames: Set<string>,
): Array<Extract<FunctionExprDef, { kind: "concat" }>["parts"][number]> => {
  if (expr.kind === "concat") {
    return expr.parts.flatMap((part) => astToFunctionExprParts(part, paramNames));
  }
  return [astToFunctionExprPart(expr, paramNames)];
};

const astToFunctionExprPart = (
  expr: FreeObjectExpr,
  paramNames: Set<string>,
): Extract<FunctionExprDef, { kind: "param_ref" | "literal" }> => {
  if (expr.kind === "cast") {
    return astToFunctionExprPart(expr.expr, paramNames);
  }

  if (expr.kind === "binding_ref" && paramNames.has(expr.name)) {
    return {
      kind: "param_ref",
      name: expr.name,
    };
  }

  if (expr.kind === "literal") {
    return {
      kind: "literal",
      value: expr.value,
    };
  }

  return {
    kind: "literal",
    value: expr.kind === "binding_ref" ? expr.name : "",
  };
};

const parseFunctionLiteral = (source: string): ScalarValue => {
  if ((source.startsWith("'") && source.endsWith("'")) || (source.startsWith('"') && source.endsWith('"'))) {
    return source.slice(1, -1);
  }

  if (source === "true") {
    return true;
  }

  if (source === "false") {
    return false;
  }

  if (source === "null") {
    return null;
  }

  const numeric = Number(source);
  if (!Number.isNaN(numeric)) {
    return numeric;
  }

  return source;
};

const renderFunctionExpr = (expr: FunctionExprDef): string => {
  if (expr.kind === "param_ref") {
    return expr.name;
  }

  if (expr.kind === "literal") {
    return renderScalarLiteral(expr.value);
  }

  return expr.parts
    .map((part) => (part.kind === "param_ref" ? part.name : renderScalarLiteral(part.value)))
    .join(" ++ ");
};

const renderScalarLiteral = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return String(value);
  }
  return `'${String(value).replaceAll("'", "\\'")}'`;
};
