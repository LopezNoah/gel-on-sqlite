import type { FunctionDef, FunctionExprDef, ScalarValue, TypeDef } from "../types.js";
import type { DeclarativeSchema, FunctionDeclaration, LinkMember, PropertyMember, TypeMember } from "./declarative.js";
import { SchemaSnapshot } from "./schema.js";

export const schemaSnapshotFromDeclarative = (schema: DeclarativeSchema): SchemaSnapshot => {
  const typeDefs = typeDefsFromDeclarative(schema);
  const scalarTypeDefs = scalarTypeDefsFromDeclarative(schema);
  return new SchemaSnapshot([...typeDefs, ...scalarTypeDefs], functionDefsFromDeclarative(schema));
};

export const scalarTypeDefsFromDeclarative = (schema: DeclarativeSchema): TypeDef[] => {
  return (schema.scalarTypes ?? []).map((st) => ({
    name: st.name,
    module: st.module,
    fields: [{ name: "__enum__", type: "str" as const, enumValues: [...st.enumValues] }],
  }));
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
  const standardAnnotations = new Map<string, boolean>([
    ["std::title", false],
    ["std::description", false],
    ["std::deprecated", false],
  ]);

  const annotationDefs = new Map<string, boolean>(standardAnnotations);
  for (const annotation of schema.abstractAnnotations ?? []) {
    annotationDefs.set(annotation.name, Boolean(annotation.inheritable));
  }

  for (const annotation of schema.abstractAnnotations ?? []) {
    for (const nested of annotation.annotations ?? []) {
      if (!annotationDefs.has(nested.name)) {
        throw new Error(`Unknown annotation '${nested.name}' in abstract annotation ${annotation.name}`);
      }
    }
  }

  const typeByName = new Map(schema.types.map((typeDecl) => [qualifiedTypeName(typeDecl), typeDecl]));
  const resolvedMemberCache = new Map<string, TypeMember[]>();
  const resolvedTypeAnnotationsCache = new Map<string, NonNullable<TypeDef["annotations"]>>();

  const validateAnnotation = (annotationName: string, context: string): void => {
    if (!annotationDefs.has(annotationName)) {
      throw new Error(`Unknown annotation '${annotationName}' in ${context}`);
    }
  };

  const mergeAnnotations = (
    inherited: NonNullable<TypeDef["annotations"]>,
    own: NonNullable<TypeDef["annotations"]>,
  ): NonNullable<TypeDef["annotations"]> => {
    const merged = [...inherited, ...own];
    const deduped = new Map<string, (typeof merged)[number]>();
    for (const annotation of merged) {
      deduped.set(annotation.name, annotation);
    }
    return [...deduped.values()];
  };

  const inheritAnnotations = (
    annotations: NonNullable<TypeDef["annotations"]>,
  ): NonNullable<TypeDef["annotations"]> => {
    return annotations.filter((annotation) => annotationDefs.get(annotation.name) === true);
  };

  const resolveTypeAnnotations = (
    typeDecl: DeclarativeSchema["types"][number],
    stack = new Set<string>(),
  ): NonNullable<TypeDef["annotations"]> => {
    const typeName = qualifiedTypeName(typeDecl);
    const cached = resolvedTypeAnnotationsCache.get(typeName);
    if (cached) {
      return cached.map((annotation) => ({ ...annotation }));
    }

    if (stack.has(typeName)) {
      return [];
    }
    stack.add(typeName);

    const inherited: NonNullable<TypeDef["annotations"]> = [];
    for (const baseName of typeDecl.extends ?? []) {
      const baseDecl = typeByName.get(baseName);
      if (!baseDecl) {
        throw new Error(`Unknown base type '${baseName}' in ${typeName}`);
      }
      inherited.push(...inheritAnnotations(resolveTypeAnnotations(baseDecl, stack)));
    }

    const own = (typeDecl.annotations ?? []).map((annotation) => {
      validateAnnotation(annotation.name, `${typeName}`);
      return { ...annotation };
    });
    const resolved = mergeAnnotations(inherited, own);
    resolvedTypeAnnotationsCache.set(typeName, resolved);
    stack.delete(typeName);
    return resolved.map((annotation) => ({ ...annotation }));
  };

  const isSubtypeOf = (candidate: string, target: string, seen = new Set<string>()): boolean => {
    if (candidate === target) {
      return true;
    }
    if (seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);

    const typeDecl = typeByName.get(candidate);
    if (!typeDecl) {
      return false;
    }

    return (typeDecl.extends ?? []).some((baseName) => isSubtypeOf(baseName, target, seen));
  };

  const cloneMemberForInheritance = (member: TypeMember): TypeMember => {
    if (member.kind === "property") {
      return {
        ...member,
        annotations: inheritAnnotations(member.annotations),
        rewrite: member.rewrite
          ? {
              onInsert: member.rewrite.onInsert,
              onUpdate: member.rewrite.onUpdate,
            }
          : undefined,
      };
    }

    if (member.kind === "computed") {
      return {
        ...member,
        annotations: inheritAnnotations(member.annotations),
        expr:
          member.expr.kind === "concat"
            ? { ...member.expr, parts: member.expr.parts.map((part) => ({ ...part })) }
            : { ...member.expr },
      };
    }

    return {
      ...member,
      annotations: inheritAnnotations(member.annotations),
      properties: member.properties.map((property) => ({
        ...property,
        annotations: inheritAnnotations(property.annotations),
      })),
    };
  };

  const resolveMembers = (typeDecl: DeclarativeSchema["types"][number], stack = new Set<string>()): TypeMember[] => {
    const typeName = qualifiedTypeName(typeDecl);
    const cached = resolvedMemberCache.get(typeName);
    if (cached) {
      return cached.map((member) => cloneMemberForInheritance(member));
    }

    if (stack.has(typeName)) {
      return [];
    }
    stack.add(typeName);

    const inheritedMembers: TypeMember[] = [];
    for (const baseName of typeDecl.extends ?? []) {
      const baseDecl = typeByName.get(baseName);
      if (!baseDecl) {
        throw new Error(`Unknown base type '${baseName}' in ${typeName}`);
      }
      inheritedMembers.push(...resolveMembers(baseDecl, stack).map((member) => cloneMemberForInheritance(member)));
    }

    const merged = [...inheritedMembers];
    for (const ownMember of typeDecl.members) {
      const own = cloneMember(ownMember);
      validateMemberAnnotations(own, annotationDefs, typeName);
      const existingIndex = merged.findIndex((candidate) => candidate.name === own.name);

      if (existingIndex < 0) {
        if (own.overloaded) {
          throw new Error(`'overloaded' member '${own.name}' on ${typeName} does not override an inherited member`);
        }
        merged.push(own);
        continue;
      }

      if (!own.overloaded) {
        throw new Error(`member '${own.name}' on ${typeName} must be declared as overloaded`);
      }

      const baseMember = merged[existingIndex];
      assertOverloadCompatibility(baseMember, own, typeName, isSubtypeOf);
      merged[existingIndex] = mergeOverloadedMember(baseMember, own, inheritAnnotations, mergeAnnotations);
    }

    resolvedMemberCache.set(typeName, merged.map((member) => cloneMember(member)));
    stack.delete(typeName);
    return merged.map((member) => cloneMember(member));
  };

  return schema.types.map((typeDecl) => {
    const links: NonNullable<TypeDef["links"]> = [];
    const fields: TypeDef["fields"] = [];
    const computeds: NonNullable<TypeDef["computeds"]> = [];
    const mutationRewrites: NonNullable<TypeDef["mutationRewrites"]> = [];

    for (const member of resolveMembers(typeDecl)) {
      if (member.kind === "property") {
        fields.push({
          name: member.name,
          type: member.scalar,
          required: member.required,
          multi: member.multi,
          annotations: (member.annotations ?? []).length ? [...member.annotations] : undefined,
          enumValues: member.enumValues,
          enumTypeName: member.enumTypeName,
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
          } else {
            throw new Error(`Computed '${member.name}' has invalid property expression kind '${member.expr.kind}'`);
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
          } else {
            throw new Error(`Computed '${member.name}' has invalid link expression kind '${member.expr.kind}'`);
          }
        }
        continue;
      }

      links.push({
        name: member.name,
        targetType: normalizeTypeName(member.target, typeDecl.module),
        multi: member.multi,
        properties: member.properties.length
          ? member.properties.map((property) => ({
              name: property.name,
              type: property.scalar,
              required: property.required,
              annotations: property.annotations.length ? [...property.annotations] : undefined,
            }))
          : undefined,
        annotations: (member.annotations ?? []).length ? [...member.annotations] : undefined,
      });

      if (!member.multi && member.properties.length === 0) {
        fields.push({
          name: `${member.name}_id`,
          type: "uuid",
          required: member.required,
        });
      }
    }

    return {
      module: typeDecl.module,
      name: typeDecl.name,
      abstract: typeDecl.abstract,
      extends: (typeDecl.extends ?? []).length ? [...typeDecl.extends] : undefined,
      annotations: resolveTypeAnnotations(typeDecl).length ? resolveTypeAnnotations(typeDecl) : undefined,
      fields,
      links: links.length ? links : undefined,
      computeds: computeds.length ? computeds : undefined,
      mutationRewrites: mutationRewrites.length ? mutationRewrites : undefined,
      triggers: typeDecl.triggers.length ? [...typeDecl.triggers] : undefined,
      accessPolicies: typeDecl.accessPolicies.length ? [...typeDecl.accessPolicies] : undefined,
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
                multi: Boolean(link.multi),
                overloaded: false,
                annotations: [...(link.annotations ?? [])],
                properties: (link.properties ?? []).map((property) => ({
                  name: property.name,
                  scalar: property.type,
                  required: Boolean(property.required),
                  annotations: [...(property.annotations ?? [])],
                })),
              };

              members.push(linkMember);
            }

            for (const field of typeDef.fields) {
              if (field.name === "id" || consumedFields.has(field.name)) {
                continue;
              }

              const rewrite = typeDef.mutationRewrites?.find((candidate) => candidate.field === field.name);

              const member: PropertyMember = {
                kind: "property",
                name: field.name,
                scalar: field.type,
                required: Boolean(field.required),
                multi: Boolean(field.multi),
                overloaded: false,
                annotations: [...(field.annotations ?? [])],
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
          const rewriteOps: string[] = [];
          if (member.rewrite?.onInsert) {
            rewriteOps.push(`insert using (${renderMutationRewriteExpr(member.rewrite.onInsert)})`);
          }
          if (member.rewrite?.onUpdate) {
            rewriteOps.push(`update using (${renderMutationRewriteExpr(member.rewrite.onUpdate)})`);
          }
          if (rewriteOps.length === 2) {
            const expr = renderMutationRewriteExpr(member.rewrite!.onInsert!);
            if (expr === renderMutationRewriteExpr(member.rewrite!.onUpdate!)) {
              lines.push(`      rewrite insert, update using (${expr});`);
            } else {
              lines.push(`      rewrite insert using (${renderMutationRewriteExpr(member.rewrite!.onInsert!)});`);
              lines.push(`      rewrite update using (${renderMutationRewriteExpr(member.rewrite!.onUpdate!)});`);
            }
          } else if (member.rewrite?.onInsert) {
            lines.push(`      rewrite insert using (${renderMutationRewriteExpr(member.rewrite.onInsert)});`);
          } else if (member.rewrite?.onUpdate) {
            lines.push(`      rewrite update using (${renderMutationRewriteExpr(member.rewrite.onUpdate)});`);
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
          lines.push(`    ${prefix}${member.name} -> ${shortTypeName(member.target, moduleName)};`);
          continue;
        }

        lines.push(`    ${prefix}${member.name} -> ${shortTypeName(member.target, moduleName)} {`);
        for (const annotation of member.annotations ?? []) {
          lines.push(`      annotation ${shortTypeName(annotation.name, moduleName)} := ${quoteString(annotation.value)};`);
        }
        for (const linkProperty of member.properties) {
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
        lines.push(
          `    access policy ${policy.name} ${policy.effect} ${operationList} using (${renderPolicyCondition(policy.condition, moduleName)});`,
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

const qualifiedTypeName = (typeDecl: DeclarativeSchema["types"][number]): string => {
  return `${typeDecl.module}::${typeDecl.name}`;
};

const cloneMember = (member: TypeMember): TypeMember => {
  if (member.kind === "property") {
    return {
      ...member,
      annotations: member.annotations.map((annotation) => ({ ...annotation })),
      rewrite: member.rewrite
        ? {
            onInsert: member.rewrite.onInsert,
            onUpdate: member.rewrite.onUpdate,
          }
        : undefined,
    };
  }

  if (member.kind === "computed") {
    return {
      ...member,
      annotations: member.annotations.map((annotation) => ({ ...annotation })),
      expr:
        member.expr.kind === "concat"
          ? { ...member.expr, parts: member.expr.parts.map((part) => ({ ...part })) }
          : { ...member.expr },
    };
  }

  return {
    ...member,
    annotations: member.annotations.map((annotation) => ({ ...annotation })),
    properties: member.properties.map((property) => ({
      ...property,
      annotations: property.annotations.map((annotation) => ({ ...annotation })),
    })),
  };
};

const validateMemberAnnotations = (
  member: TypeMember,
  annotationDefs: Map<string, boolean>,
  context: string,
): void => {
  for (const annotation of member.annotations) {
    if (!annotationDefs.has(annotation.name)) {
      throw new Error(`Unknown annotation '${annotation.name}' in ${context}.${member.name}`);
    }
  }

  if (member.kind === "link") {
    for (const property of member.properties) {
      for (const annotation of property.annotations) {
        if (!annotationDefs.has(annotation.name)) {
          throw new Error(`Unknown annotation '${annotation.name}' in ${context}.${member.name}@${property.name}`);
        }
      }
    }
  }
};

const assertOverloadCompatibility = (
  baseMember: TypeMember,
  overloadedMember: TypeMember,
  typeName: string,
  isSubtypeOf: (candidate: string, target: string) => boolean,
): void => {
  if (baseMember.kind !== overloadedMember.kind) {
    throw new Error(`overloaded member '${overloadedMember.name}' on ${typeName} must keep member kind`);
  }

  if (baseMember.kind === "property" && overloadedMember.kind === "property") {
    if (baseMember.scalar !== overloadedMember.scalar) {
      throw new Error(`overloaded property '${overloadedMember.name}' on ${typeName} must keep scalar type`);
    }
    return;
  }

  if (baseMember.kind === "link" && overloadedMember.kind === "link") {
    if (baseMember.multi !== overloadedMember.multi) {
      throw new Error(`overloaded link '${overloadedMember.name}' on ${typeName} must keep cardinality`);
    }

    const baseTarget = baseMember.target;
    const overloadedTarget = overloadedMember.target;
    if (!isSubtypeOf(overloadedTarget, baseTarget)) {
      throw new Error(
        `overloaded link '${overloadedMember.name}' on ${typeName} must narrow to subtype of '${baseTarget}'`,
      );
    }
    return;
  }

  if (baseMember.kind === "computed" && overloadedMember.kind === "computed") {
    if (baseMember.computedKind !== overloadedMember.computedKind) {
      throw new Error(`overloaded computed '${overloadedMember.name}' on ${typeName} must keep computed kind`);
    }
    return;
  }
};

const mergeOverloadedMember = (
  baseMember: TypeMember,
  overloadedMember: TypeMember,
  inheritAnnotations: (annotations: NonNullable<TypeDef["annotations"]>) => NonNullable<TypeDef["annotations"]>,
  mergeAnnotations: (
    inherited: NonNullable<TypeDef["annotations"]>,
    own: NonNullable<TypeDef["annotations"]>,
  ) => NonNullable<TypeDef["annotations"]>,
): TypeMember => {
  if (overloadedMember.kind === "property" && baseMember.kind === "property") {
    return {
      ...overloadedMember,
      annotations: mergeAnnotations(inheritAnnotations(baseMember.annotations), overloadedMember.annotations),
    };
  }

  if (overloadedMember.kind === "link" && baseMember.kind === "link") {
    return {
      ...overloadedMember,
      annotations: mergeAnnotations(inheritAnnotations(baseMember.annotations), overloadedMember.annotations),
      properties: overloadedMember.properties.map((property) => ({
        ...property,
        annotations: [...property.annotations],
      })),
    };
  }

  if (overloadedMember.kind === "computed" && baseMember.kind === "computed") {
    return {
      ...overloadedMember,
      annotations: mergeAnnotations(inheritAnnotations(baseMember.annotations), overloadedMember.annotations),
      expr:
        overloadedMember.expr.kind === "concat"
          ? {
              ...overloadedMember.expr,
              parts: overloadedMember.expr.parts.map((part) => ({ ...part })),
            }
          : { ...overloadedMember.expr },
    };
  }

  return overloadedMember;
};

const quoteString = (value: string): string => `'${value.replaceAll("'", "\\'")}'`;

const renderComputedExpr = (expr: Extract<TypeMember, { kind: "computed" }>['expr'], moduleName: string): string => {
  if (expr.kind === "field_ref") {
    return `.${expr.field}`;
  }

  if (expr.kind === "literal") {
    return renderScalarLiteral(expr.value);
  }

  if (expr.kind === "concat") {
    return expr.parts
      .map((part) => (part.kind === "field_ref" ? `.${part.field}` : renderScalarLiteral(part.value)))
      .join(" ++ ");
  }

  if (expr.kind === "backlink") {
    const source = expr.sourceType ? `[is ${shortTypeName(expr.sourceType, moduleName)}]` : "";
    return `.<${expr.link}${source}`;
  }

  if (!expr.filter) {
    return `(select .${expr.link})`;
  }

  const op = expr.filter.op;
  return `(select .${expr.link} filter .${expr.filter.field} ${op} ${renderScalarLiteral(expr.filter.value)})`;
};

const normalizeTypeName = (name: string, moduleName: string): string => {
  if (name.includes("::")) {
    return name;
  }
  return `${moduleName}::${name}`;
};

const shortTypeName = (name: string, moduleName: string): string => {
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
  const head = trimmed.toLowerCase();
  if (head.startsWith("select ") || head.startsWith("insert ") || head.startsWith("update ") || head.startsWith("delete ") || head.startsWith("with ")) {
    return {
      kind: "query",
      language: fn.body.language,
      query: trimmed,
    };
  }

  return {
    kind: "expr",
    expr: parseFunctionExpr(trimmed, new Set(fn.params.map((param) => param.name))),
  };
};

const parseFunctionExpr = (source: string, paramNames: Set<string>): FunctionExprDef => {
  const parts = source.split("++").map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return { kind: "literal", value: "" };
  }

  const parsedParts = parts.map((part) => parseFunctionExprPart(part, paramNames));
  if (parsedParts.length === 1) {
    return parsedParts[0];
  }

  return {
    kind: "concat",
    parts: parsedParts,
  };
};

const parseFunctionExprPart = (
  source: string,
  paramNames: Set<string>,
): Extract<FunctionExprDef, { kind: "param_ref" | "literal" }> => {
  if (paramNames.has(source)) {
    return {
      kind: "param_ref",
      name: source,
    };
  }

  return {
    kind: "literal",
    value: parseFunctionLiteral(source),
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
