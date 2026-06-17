// Physical storage layout — the single home for "given the logical schema,
// what is the physical SQLite layout?". The SchemaSnapshot is the authoritative
// *logical* schema; this module derives the *physical* facts the SQL compiler
// and the runtime evaluator both need:
//
//   - which type's table physically owns an inherited link's junction table
//     (resolveLinkStorageOwner / makeLinkStorageOwnerResolver),
//   - which physical columns a type's table has, with inline-FK exclusion for
//     links overridden into junction storage (makeTypeStorageColumnsResolver),
//   - whether a link is stored as a junction table or an inline `<name>_id`
//     column (`usesLinkTable`, re-exported from its schema-core home).
//
// These rules used to be re-derived per consumer: the owner walk lived in
// `runtime/engine.ts` and was hand-mirrored in `compiler/service.ts` (the two
// copies had already drifted — the runtime guarded the walk with
// `linkDefsEquivalent`, the mirror did not), and the column set lived only in
// `service.ts`. The SQL compiler already exposes the seam (the
// `resolveTypeColumns` / `resolveLinkStorageType` callbacks on its options); the
// adapters now come from here, so the compile path and the runtime path read one
// rule set instead of two that can disagree. See docs/adr/0010.
import { qualifiedTypeName, usesLinkTable, type SchemaSnapshot } from "./schema.js";
import type { TypeDef } from "../types.js";

export { usesLinkTable };

type LinkDef = NonNullable<TypeDef["links"]>[number];

// Two link declarations describe the same physical junction table iff they agree
// on name, target, multiplicity, and link-property shape. The owner walk uses
// this to stop at a subtype that re-declares a link incompatibly *without*
// marking it `overloaded`: such a subtype has its own storage, so the walk must
// not attribute it to the base.
const linkDefsEquivalent = (a: LinkDef, b: LinkDef): boolean => {
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

// Inherited link tables live on the most-base type where the link is defined
// (e.g. `Owned.owner` stays in `default__owned__owner`, not in each subtype's
// own table). An `overloaded` link, or a base re-declaration that is not
// `linkDefsEquivalent`, stops the walk: that type owns its own storage.
export const resolveLinkStorageOwner = (
  schema: SchemaSnapshot,
  typeDef: TypeDef,
  link: LinkDef,
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

// Compile-side adapter for `resolveLinkStorageType`: the SQL compiler holds a
// (sourceTypeName, linkName) pair and wants the qualified name of the owning
// table's type. Cached per build, matching the engine's per-call use.
export const makeLinkStorageOwnerResolver = (
  schema: SchemaSnapshot,
): ((sourceTypeName: string, linkName: string) => string | undefined) => {
  const cache = new Map<string, string>();
  return (sourceTypeName: string, linkName: string): string | undefined => {
    const key = `${sourceTypeName}|${linkName}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const typeDef = schema.getType(sourceTypeName);
    if (!typeDef) return undefined;
    const link = (typeDef.links ?? []).find((l) => l.name === linkName);
    if (!link) return undefined;
    const ownerName = qualifiedTypeName(resolveLinkStorageOwner(schema, typeDef, link));
    cache.set(key, ownerName);
    return ownerName;
  };
};

// Compile-side adapter for `resolveTypeColumns`: the physical columns of a
// type's table, walking subtype→base with first-seen-wins on link names so the
// most-derived definition decides storage. An inline single link (no link
// properties) stores a `<link>_id` FK column, which the schema also lists as a
// field on the declaring type. A subtype can override the link's storage (e.g.
// overloading it with properties → link table), so that subtype's table has NO
// such column even though it inherits the base's field list; resolving link
// storage first lets the FK-field exclusion be known before fields are added,
// so the polymorphic source projects NULL there instead of referencing a
// missing column.
export const makeTypeStorageColumnsResolver = (
  schema: SchemaSnapshot,
): ((typeName: string) => Set<string> | undefined) => {
  const cache = new Map<string, Set<string>>();
  const collect = (
    qualifiedName: string,
    accumulator: Set<string>,
    seen: Set<string>,
    seenLinks: Set<string>,
    excludeFKs: Set<string>,
  ): void => {
    if (seen.has(qualifiedName)) return;
    seen.add(qualifiedName);
    const typeDef = schema.getType(qualifiedName);
    if (!typeDef) return;
    // Resolve link storage first so FK-field exclusions are known before we
    // add (possibly inherited) fields.
    for (const link of typeDef.links ?? []) {
      if (seenLinks.has(link.name)) continue;
      seenLinks.add(link.name);
      const fkColumn = `${link.name}_id`;
      if (!usesLinkTable(link)) {
        accumulator.add(fkColumn);
      } else {
        excludeFKs.add(fkColumn);
      }
    }
    for (const field of typeDef.fields ?? []) {
      if (!excludeFKs.has(field.name)) {
        accumulator.add(field.name);
      }
    }
    for (const baseName of typeDef.extends ?? []) {
      collect(baseName, accumulator, seen, seenLinks, excludeFKs);
    }
  };
  return (typeName: string): Set<string> | undefined => {
    const existing = cache.get(typeName);
    if (existing) return existing;
    const columns = new Set<string>(["id"]);
    collect(typeName, columns, new Set<string>(), new Set<string>(), new Set<string>());
    if (columns.size === 1 && !schema.getType(typeName)) {
      return undefined;
    }
    cache.set(typeName, columns);
    return columns;
  };
};
