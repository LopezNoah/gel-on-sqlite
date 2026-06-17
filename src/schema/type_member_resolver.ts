// Inheritance + overload resolution for declarative-schema members — the one
// home for "given a type declaration, what is its full member list once bases
// are folded in and `overloaded` members are merged?". This was a nested
// closure inside `typeDefsFromDeclarative` (`uiSchema.ts`), reachable only by
// converting a whole DeclarativeSchema; it is a self-contained sub-problem with
// sharp invariants (overload compatibility, link-property merge, cycle guard),
// so it gets a small interface (`resolveMembers`) and its own test surface.
// See docs/adr/0036.
import type { AnnotationDef, ConstraintDef } from "../types.js";
import type { DeclarativeSchema, TypeMember } from "./declarative.js";
import { AnnotationRegistry, AnnotationSet } from "./annos.js";
import { qualifiedTypeName } from "./schema.js";

type TypeDeclaration = DeclarativeSchema["types"][number];

const cloneConstraint = (constraint: ConstraintDef): ConstraintDef => ({
  name: constraint.name,
  annotations: constraint.annotations.map((annotation) => ({ ...annotation })),
  delegated: constraint.delegated,
  params: constraint.params ? constraint.params.map((param) => ({ ...param })) : undefined,
  onExpr: constraint.onExpr,
  exceptExpr: constraint.exceptExpr,
});

export const cloneConstraints = (constraints: ConstraintDef[]): ConstraintDef[] => constraints.map(cloneConstraint);

const mergeConstraintSets = (base: ConstraintDef[], override: ConstraintDef[]): ConstraintDef[] => {
  const map = new Map<string, ConstraintDef>();
  for (const constraint of base) {
    map.set(constraint.name, cloneConstraint(constraint));
  }
  for (const constraint of override) {
    map.set(constraint.name, cloneConstraint(constraint));
  }
  return [...map.values()];
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
      constraints: cloneConstraints(member.constraints),
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

const validateAnnotations = (
  annotations: AnnotationDef[],
  annotationRegistry: AnnotationRegistry,
  context: string,
): void => {
  for (const annotation of annotations) {
    annotationRegistry.ensureKnown(annotation.name, context);
  }
};

const validateMemberAnnotations = (
  member: TypeMember,
  annotationRegistry: AnnotationRegistry,
  context: string,
): void => {
  validateAnnotations(member.annotations, annotationRegistry, `${context}.${member.name}`);

  if (member.kind === "property") {
    for (const constraint of member.constraints) {
      validateAnnotations(
        constraint.annotations,
        annotationRegistry,
        `${context}.${member.name}@constraint`,
      );
    }
  }

  if (member.kind === "link") {
    for (const property of member.properties) {
      validateAnnotations(
        property.annotations,
        annotationRegistry,
        `${context}.${member.name}@${property.name}`,
      );
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
  annotationRegistry: AnnotationRegistry,
): TypeMember => {
  const baseAnnotations = AnnotationSet.from(baseMember.annotations)
    .inherit(annotationRegistry)
    .merge(AnnotationSet.from(overloadedMember.annotations))
    .toArray();

  if (overloadedMember.kind === "property" && baseMember.kind === "property") {
    return {
      ...overloadedMember,
      annotations: baseAnnotations,
      constraints: mergeConstraintSets(baseMember.constraints, overloadedMember.constraints),
    };
  }

  if (overloadedMember.kind === "link" && baseMember.kind === "link") {
    // Merge link properties: keep base's by default, let the overload
    // override per name. Without this, `overloaded link owner { property
    // since: datetime }` would shadow Owned.owner's `note` property and
    // splats over the inherited link would silently drop `@note`.
    const propsByName = new Map<string, typeof overloadedMember.properties[number]>();
    for (const property of baseMember.properties) {
      propsByName.set(property.name, {
        ...property,
        annotations: [...property.annotations],
      });
    }
    for (const property of overloadedMember.properties) {
      propsByName.set(property.name, {
        ...property,
        annotations: [...property.annotations],
      });
    }
    return {
      ...overloadedMember,
      annotations: baseAnnotations,
      properties: [...propsByName.values()],
    };
  }

  return {
    ...overloadedMember,
    annotations: baseAnnotations,
  };
};

// Resolves a type's full member list, folding in inherited members from its
// bases (first-seen-wins on name) and merging `overloaded` re-declarations.
// Constructed once per declarative schema with the abstract-annotation
// registry; caches resolved member lists and hands out deep clones so callers
// can mutate freely.
export class TypeMemberResolver {
  private readonly typeByName: Map<string, TypeDeclaration>;
  private readonly cache = new Map<string, TypeMember[]>();

  constructor(
    types: readonly TypeDeclaration[],
    private readonly annotationRegistry: AnnotationRegistry,
  ) {
    this.typeByName = new Map(types.map((typeDecl) => [qualifiedTypeName(typeDecl), typeDecl]));
  }

  private inheritMemberAnnotations(annotations: AnnotationDef[]): AnnotationDef[] {
    return AnnotationSet.from(annotations).inherit(this.annotationRegistry).toArray();
  }

  private isSubtypeOf(candidate: string, target: string, seen = new Set<string>()): boolean {
    if (candidate === target) {
      return true;
    }
    if (seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);

    const typeDecl = this.typeByName.get(candidate);
    if (!typeDecl) {
      return false;
    }

    return (typeDecl.extends ?? []).some((baseName) => this.isSubtypeOf(baseName, target, seen));
  }

  private cloneMemberForInheritance(member: TypeMember): TypeMember {
    if (member.kind === "property") {
      return {
        ...member,
        annotations: this.inheritMemberAnnotations(member.annotations),
        rewrite: member.rewrite
          ? {
              onInsert: member.rewrite.onInsert,
              onUpdate: member.rewrite.onUpdate,
            }
          : undefined,
        constraints: cloneConstraints(member.constraints),
      };
    }

    if (member.kind === "computed") {
      return {
        ...member,
        annotations: this.inheritMemberAnnotations(member.annotations),
        expr:
          member.expr.kind === "concat"
            ? { ...member.expr, parts: member.expr.parts.map((part) => ({ ...part })) }
            : { ...member.expr },
      };
    }

    return {
      ...member,
      annotations: this.inheritMemberAnnotations(member.annotations),
      properties: member.properties.map((property) => ({
        ...property,
        annotations: this.inheritMemberAnnotations(property.annotations),
      })),
    };
  }

  resolveMembers(typeDecl: TypeDeclaration, stack = new Set<string>()): TypeMember[] {
    const typeName = qualifiedTypeName(typeDecl);
    const cached = this.cache.get(typeName);
    if (cached) {
      return cached.map((member) => this.cloneMemberForInheritance(member));
    }

    if (stack.has(typeName)) {
      return [];
    }
    stack.add(typeName);

    const inheritedMembers: TypeMember[] = [];
    const inheritedNames = new Set<string>();
    for (const baseName of typeDecl.extends ?? []) {
      const baseDecl = this.typeByName.get(baseName);
      if (!baseDecl) {
        throw new Error(`Unknown base type '${baseName}' in ${typeName}`);
      }
      for (const member of this.resolveMembers(baseDecl, stack).map((member) => this.cloneMemberForInheritance(member))) {
        if (!inheritedNames.has(member.name)) {
          inheritedMembers.push(member);
          inheritedNames.add(member.name);
        }
      }
    }

    const merged = [...inheritedMembers];
    for (const ownMember of typeDecl.members) {
      const own = cloneMember(ownMember);
      validateMemberAnnotations(own, this.annotationRegistry, typeName);
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
      assertOverloadCompatibility(baseMember, own, typeName, (candidate, target) => this.isSubtypeOf(candidate, target));
      merged[existingIndex] = mergeOverloadedMember(baseMember, own, this.annotationRegistry);
    }

    this.cache.set(typeName, merged.map((member) => cloneMember(member)));
    stack.delete(typeName);
    return merged.map((member) => cloneMember(member));
  }
}
