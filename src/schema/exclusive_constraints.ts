import type { SchemaSnapshot } from "./schema.js";
import { qualifiedTypeName } from "./schema.js";
import type { TypeDef } from "../types.js";

export interface ExclusiveConstraintFact {
  kind: "field" | "type";
  /** The identity used to group physical enforcement for this constraint. */
  ownerTypeName: string;
  /** Concrete type names covered by this constraint for this effective type. */
  typeNames: string[];
  fields: string[];
  columns: string[];
  delegated: boolean;
  fromParent: boolean;
  lower: boolean;
  exceptField?: string;
  multiProp?: string;
}

type ExclusiveConstraintLike = {
  name: string;
  delegated?: boolean;
  onExpr?: string;
  exceptExpr?: string;
};

export const constraintIsExclusiveLike = (constraint: { name: string }): boolean =>
  constraint.name === "std::exclusive" || constraint.name === "exclusive";

export const typeAncestorsOf = (schema: SchemaSnapshot, typeDef: TypeDef): TypeDef[] => {
  const seen = new Set<string>();
  const out: TypeDef[] = [];
  const visit = (name: string): void => {
    const type = schema.getType(name);
    if (!type || seen.has(qualifiedTypeName(type))) return;
    seen.add(qualifiedTypeName(type));
    out.push(type);
    for (const base of type.extends ?? []) visit(base);
  };
  for (const base of typeDef.extends ?? []) visit(base);
  return out;
};

// Only the single own-field form is represented by SQLite's exclusivity
// machinery. Keep the recognition strict so both physical enforcement and
// conflict probing agree about unsupported expressions.
const exclusiveExceptField = (exceptExpr?: string): string | undefined => {
  if (!exceptExpr) return undefined;
  const match = /^\(?\s*\.([A-Za-z_][A-Za-z0-9_]*)\s*\)?$/.exec(exceptExpr);
  return match?.[1];
};

const exclusiveFields = (constraint: { fieldRefs: string[]; exprText?: string }): string[] => {
  if (constraint.fieldRefs.length > 0) return constraint.fieldRefs;
  const refs: string[] = [];
  const pattern = /(?:__subject__|)\s*\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(constraint.exprText ?? "")) !== null) refs.push(match[1]);
  return refs;
};

const coveredTypes = (
  schema: SchemaSnapshot,
  typeDef: TypeDef,
  declaringType: TypeDef,
  delegated: boolean,
): string[] => {
  const typeName = qualifiedTypeName(typeDef);
  if (delegated) return [typeName];
  return [
    ...new Set([...schema.concreteTypeNamesUnder(qualifiedTypeName(declaringType)), typeName]),
  ];
};

/**
 * Describe the exclusive constraints visible on one type. Both schema
 * materialization and INSERT conflict planning consume these same facts, so
 * inheritance coverage and expression interpretation have one implementation.
 */
export const exclusiveConstraintFactsForType = (
  schema: SchemaSnapshot,
  typeDef: TypeDef,
): ExclusiveConstraintFact[] => {
  const typeName = qualifiedTypeName(typeDef);
  const ancestors = typeAncestorsOf(schema, typeDef);
  const links = new Set((typeDef.links ?? []).map((link) => link.name));
  const columnFor = (field: string): string => (links.has(field) ? `${field}_id` : field);
  const facts: ExclusiveConstraintFact[] = [];

  for (const field of typeDef.fields) {
    if (field.name === "id") continue;
    const constraints = (field as { constraints?: ExclusiveConstraintLike[] }).constraints ?? [];
    const constraint = constraints.find(constraintIsExclusiveLike);
    if (!constraint) continue;

    let declaringType = typeDef;
    for (const ancestor of ancestors) {
      const inheritedField = ancestor.fields.find((candidate) => candidate.name === field.name) as
        | { constraints?: Array<{ name: string }> }
        | undefined;
      if (inheritedField?.constraints?.some(constraintIsExclusiveLike)) declaringType = ancestor;
    }

    const delegated = constraint.delegated === true;
    facts.push({
      kind: "field",
      ownerTypeName: delegated ? typeName : qualifiedTypeName(declaringType),
      typeNames: coveredTypes(schema, typeDef, declaringType, delegated),
      fields: [field.name],
      columns: [columnFor(field.name)],
      delegated,
      fromParent: qualifiedTypeName(declaringType) !== typeName,
      lower:
        constraint.onExpr !== undefined &&
        /str_lower\s*\(\s*__subject__\s*\)/.test(constraint.onExpr),
      exceptField: exclusiveExceptField(constraint.exceptExpr),
      multiProp: (field as { multi?: boolean }).multi ? field.name : undefined,
    });
  }

  for (const declaringType of [typeDef, ...ancestors]) {
    for (const constraint of declaringType.typeConstraints ?? []) {
      if (!constraintIsExclusiveLike(constraint)) continue;
      const fields = exclusiveFields(constraint);
      if (fields.length === 0) continue;
      const delegated = constraint.delegated === true;
      facts.push({
        kind: "type",
        ownerTypeName: delegated ? typeName : qualifiedTypeName(declaringType),
        typeNames: coveredTypes(schema, typeDef, declaringType, delegated),
        fields,
        columns: fields.map(columnFor),
        delegated,
        fromParent: declaringType !== typeDef,
        lower: /str_lower\s*\(\s*__subject__\s*\)/.test(constraint.exprText),
        exceptField: exclusiveExceptField(constraint.exceptExpr),
      });
    }
  }

  return facts;
};
