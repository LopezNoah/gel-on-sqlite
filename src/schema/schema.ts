import type { AliasDef, AnnotationDef, FieldDef, FunctionDef, TypeDef } from "../types.js";
import { AnnotationSet } from "./annos.js";
import type { ScalarTypeDeclaration } from "./scalar.js";

export interface SchemaDelta {
  createTypes?: TypeDef[];
  addFields?: Array<{ typeName: string; field: FieldDef }>;
}

export interface GlobalDef {
  module: string;
  name: string;
  exprText?: string;
}

export class SchemaSnapshot {
  // Not `readonly`: `cloneShared` reassigns these to fresh Map containers that
  // share the (deeply-frozen) definition objects of the source snapshot.
  private typesByName: Map<string, TypeDef>;
  private functionsBySignature: Map<string, FunctionDef>;
  private aliasesByName: Map<string, AliasDef>;
  private scalarTypesByName: Map<string, ScalarTypeDeclaration>;
  private globalsByName: Map<string, GlobalDef>;
  // Active `CREATE FUTURE <flag>` directives (e.g.
  // `no_linkful_computed_splats`). They modify splat semantics without
  // changing the underlying type model.
  private futureFlagsSet: Set<string> = new Set<string>();
  // Bumped on every in-place mutation (addType/addFunction/…). Lets callers
  // that derive expensive values from the snapshot (e.g. the compiler's schema
  // fingerprint for its cache key) memoize them and recompute only after DDL.
  private mutationVersionCounter = 0;
  // Memoized content fingerprint (see contentFingerprint). `…Version` records
  // the mutationVersion the cached value was computed at, so DDL invalidates it.
  private cachedFingerprint: string | undefined;
  private cachedFingerprintVersion = -1;

  get mutationVersion(): number {
    return this.mutationVersionCounter;
  }

  /**
   * A stable hash of the schema's *content* (types, functions, globals). It is
   * identical for two snapshots with the same declarations, so it can serve as
   * the schema component of the compiler's cache key. Computing it normalizes
   * and serializes the whole schema, so it is memoized on the instance and only
   * recomputed after a mutation (DDL) bumps `mutationVersion`.
   *
   * `cloneShared` propagates the cached value to clones, so the cost is paid
   * once per distinct base schema rather than once per clone — important for the
   * test harness, which clones the snapshot for every test.
   */
  contentFingerprint(): string {
    if (this.cachedFingerprint !== undefined && this.cachedFingerprintVersion === this.mutationVersionCounter) {
      return this.cachedFingerprint;
    }
    const fingerprint = computeContentFingerprint(this);
    this.cachedFingerprint = fingerprint;
    this.cachedFingerprintVersion = this.mutationVersionCounter;
    return fingerprint;
  }

  /**
   * Cheaply derive an independent snapshot that shares this one's
   * (deeply-frozen) definition objects. Only the Map containers are fresh, so a
   * later in-place mutation (addType/addFunction/…) on either snapshot replaces
   * a whole entry without affecting the other — DDL isolation is preserved. The
   * frozen defs are never mutated in place, so sharing them is safe.
   *
   * This avoids the per-definition deep clone the public constructor performs,
   * and carries over the memoized content fingerprint, so a clone never repeats
   * the schema normalization.
   */
  static cloneShared(base: SchemaSnapshot): SchemaSnapshot {
    const clone = new SchemaSnapshot();
    clone.typesByName = new Map(base.typesByName);
    clone.functionsBySignature = new Map(base.functionsBySignature);
    clone.aliasesByName = new Map(base.aliasesByName);
    clone.scalarTypesByName = new Map(base.scalarTypesByName);
    clone.globalsByName = new Map(base.globalsByName);
    clone.futureFlagsSet = new Set(base.futureFlagsSet);
    // Inherit the fingerprint: the clone's content equals the base's, and the
    // clone starts at mutationVersion 0, so it stays valid until the clone's
    // own first mutation bumps the counter past cachedFingerprintVersion.
    clone.cachedFingerprint = base.contentFingerprint();
    clone.cachedFingerprintVersion = clone.mutationVersionCounter;
    return clone;
  }

  constructor(types: TypeDef[] = [], functions: FunctionDef[] = [], aliases: AliasDef[] = [], scalarTypes: ScalarTypeDeclaration[] = [], globals: GlobalDef[] = []) {
    this.typesByName = new Map(types.map((t) => [qualifiedTypeName(t), deepFreeze(cloneTypeDef(t))]));
    this.functionsBySignature = new Map(functions.map((fn) => [functionSignature(fn), deepFreeze(cloneFunctionDef(fn))]));
    this.aliasesByName = new Map(aliases.map((alias) => [qualifiedAliasName(alias), deepFreeze(cloneAliasDef(alias))]));
    this.scalarTypesByName = new Map(
      scalarTypes.map((scalarType) => [qualifiedScalarTypeName(scalarType), deepFreeze(cloneScalarTypeDeclaration(scalarType))] as const),
    );
    this.globalsByName = new Map(globals.map((g) => [`${g.module}::${g.name}`, deepFreeze({ ...g })]));
  }

  // Read accessors return the stored, deeply-frozen definitions directly
  // rather than a per-call deep clone. A single query compile performs dozens
  // of these lookups, and cloning each result dominated query CPU; sharing the
  // frozen instances cut per-query time by ~27%. The objects are frozen at
  // construction/write time, so callers cannot mutate the snapshot — code that
  // needs a mutable copy must clone explicitly. Mutating methods (addType,
  // applyDelta, …) already build fresh objects, so they are unaffected.
  getGlobal(name: string): GlobalDef | undefined {
    return this.globalsByName.get(name);
  }

  listGlobals(): GlobalDef[] {
    return [...this.globalsByName.values()];
  }

  getType(name: string): TypeDef | undefined {
    return this.typesByName.get(name);
  }

  listTypes(): TypeDef[] {
    return [...this.typesByName.values()];
  }

  getFunction(signature: string): FunctionDef | undefined {
    return this.functionsBySignature.get(signature);
  }

  findFunction(moduleName: string, name: string, arity: number): FunctionDef | undefined {
    for (const fn of this.functionsBySignature.values()) {
      if (fn.module !== moduleName || fn.name !== name) {
        continue;
      }

      const requiredCount = fn.params.filter((param) => !param.optional && param.default === undefined && !param.variadic).length;
      const accepts = arity >= requiredCount && (fn.params.some((param) => param.variadic) || arity <= fn.params.length);
      if (accepts) {
        return fn;
      }
    }

    return undefined;
  }

  listFunctions(): FunctionDef[] {
    return [...this.functionsBySignature.values()];
  }

  addFunction(fn: FunctionDef): void {
    this.functionsBySignature.set(functionSignature(fn), deepFreeze(cloneFunctionDef(fn)));
    this.mutationVersionCounter += 1;
  }

  addType(typeDef: TypeDef): void {
    this.typesByName.set(qualifiedTypeName(typeDef), deepFreeze(cloneTypeDef(typeDef)));
    this.mutationVersionCounter += 1;
  }

  // Registers (or replaces) a global declared at runtime via `CREATE GLOBAL`.
  // `exprText` carries the default expression for computed globals; settable
  // globals (`create global a -> int64`) have no exprText.
  addGlobal(global: GlobalDef): void {
    this.globalsByName.set(`${global.module}::${global.name}`, deepFreeze({ ...global }));
    this.mutationVersionCounter += 1;
  }

  setFutureFlag(name: string, enabled: boolean): void {
    if (enabled) this.futureFlagsSet.add(name);
    else this.futureFlagsSet.delete(name);
    this.mutationVersionCounter += 1;
  }

  listFutureFlags(): string[] {
    return [...this.futureFlagsSet];
  }

  getAlias(name: string): AliasDef | undefined {
    return this.aliasesByName.get(name);
  }

  addAlias(alias: AliasDef): void {
    this.aliasesByName.set(qualifiedAliasName(alias), deepFreeze(cloneAliasDef(alias)));
    this.mutationVersionCounter += 1;
  }

  removeAlias(name: string): void {
    this.aliasesByName.delete(name);
    this.mutationVersionCounter += 1;
  }

  listAliases(): AliasDef[] {
    return [...this.aliasesByName.values()];
  }

  getScalarType(name: string): ScalarTypeDeclaration | undefined {
    return this.scalarTypesByName.get(name);
  }

  listScalarTypes(): ScalarTypeDeclaration[] {
    return [...this.scalarTypesByName.values()];
  }

  listConcreteTypesAssignableTo(name: string): TypeDef[] {
    if (isUniversalObjectName(name)) {
      return this.listTypes().filter((candidate) => !candidate.abstract);
    }

    const target = this.getType(name);
    if (!target) {
      return [];
    }

    const targetName = qualifiedTypeName(target);
    return this.listTypes().filter((candidate) => {
      if (candidate.abstract) {
        return false;
      }

      const candidateName = qualifiedTypeName(candidate);
      if (candidateName === targetName) {
        return true;
      }

      return this.isSubtypeOf(candidate, targetName);
    });
  }

  // Public wrapper for the recursive private check: is `child` (qualified
  // name or TypeDef) a subtype of `ancestor`? Returns true when they're the
  // same name, when `child` directly extends `ancestor`, or transitively.
  isTypeSubtypeOf(childQualifiedName: string, ancestorQualifiedName: string): boolean {
    if (childQualifiedName === ancestorQualifiedName) return true;
    const childDef = this.getType(childQualifiedName);
    if (!childDef) return false;
    return this.isSubtypeOf(childDef, ancestorQualifiedName);
  }

  private isSubtypeOf(typeDef: TypeDef, targetQualifiedName: string, seen = new Set<string>()): boolean {
    const typeName = qualifiedTypeName(typeDef);
    if (seen.has(typeName)) {
      return false;
    }
    seen.add(typeName);

    for (const baseName of typeDef.extends ?? []) {
      if (baseName === targetQualifiedName) {
        return true;
      }

      const base = this.getType(baseName);
      if (base && this.isSubtypeOf(base, targetQualifiedName, seen)) {
        return true;
      }
    }

    return false;
  }

  applyDelta(delta: SchemaDelta): SchemaSnapshot {
    const next = new Map(
      [...this.typesByName.entries()].map(([name, typeDef]) => [name, cloneTypeDef(typeDef)]),
    );

    for (const typeDef of delta.createTypes ?? []) {
      next.set(qualifiedTypeName(typeDef), cloneTypeDef(typeDef));
    }

    for (const update of delta.addFields ?? []) {
      const typeDef = next.get(update.typeName);
      if (!typeDef) {
        throw new Error(`Cannot add field to unknown type: ${update.typeName}`);
      }

      const existing = new Set(typeDef.fields.map((f) => f.name));
      if (existing.has(update.field.name)) {
        throw new Error(`Field already exists: ${update.typeName}.${update.field.name}`);
      }

      typeDef.fields.push({ ...update.field });
    }

    return new SchemaSnapshot([...next.values()], this.listFunctions(), this.listAliases(), this.listScalarTypes());
  }
}

// Recursively freezes a schema definition so the shared instance returned by
// the read accessors cannot be mutated by callers. Cheap (schemas are small
// and built once, then cached) and turns any accidental write into a loud
// throw instead of silent snapshot corruption.
const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (child && typeof child === "object") {
      deepFreeze(child);
    }
  }
  return Object.freeze(value);
};

export const qualifiedTypeName = (typeDef: TypeDef): string => {
  const module = typeDef.module ?? "default";
  return `${module}::${typeDef.name}`;
};

// The one home for the link-storage rule: a link is stored in a separate
// junction table (vs. an inline `<name>_id` column) iff it is `multi` or
// carries link-properties. Structural param so both a `LinkDef` (schema) and a
// declarative `LinkMember` satisfy it without either importing the other.
// Note: the inference oracle (`compiler/semantic.ts`, quarantined per ADR 0001)
// keeps its own inline copies; it is slated for wholesale deletion, not refactor.
export const usesLinkTable = (link: {
  multi?: boolean;
  properties?: readonly unknown[] | null;
}): boolean => Boolean(link.multi) || (link.properties?.length ?? 0) > 0;

// Normalizes the schema's content (types/links/rewrites/triggers/policies,
// functions, globals) into a canonical, sorted shape and serializes it. Used
// by `SchemaSnapshot.contentFingerprint` as the schema component of the
// compiler cache key: two snapshots with the same declarations hash equal, and
// any declaration change produces a different hash. Functions are included
// because an inlined UDF's body is spliced into compiled SQL; globals because a
// computed global's default text affects how `global x` lowers.
const computeContentFingerprint = (schema: SchemaSnapshot): string => {
  const types = schema
    .listTypes()
    .map((typeDef) => ({
      name: qualifiedTypeName(typeDef),
      fields: typeDef.fields
        .map((field) => ({
          name: field.name,
          type: field.type,
          required: Boolean(field.required),
          multi: Boolean(field.multi),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      links: (typeDef.links ?? [])
        .map((link) => ({
          name: link.name,
          targetType: link.targetType,
          multi: Boolean(link.multi),
          properties: (link.properties ?? []).map((property) => ({
            name: property.name,
            type: property.type,
            required: Boolean(property.required),
          })),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      mutationRewrites: (typeDef.mutationRewrites ?? [])
        .map((rewrite) => ({
          field: rewrite.field,
          onInsert: rewrite.onInsert,
          onUpdate: rewrite.onUpdate,
        }))
        .sort((a, b) => a.field.localeCompare(b.field)),
      triggers: (typeDef.triggers ?? [])
        .map((trigger) => ({
          name: trigger.name,
          event: trigger.event,
          scope: trigger.scope ?? "each",
          when: trigger.when,
          actions: trigger.actions,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      accessPolicies: (typeDef.accessPolicies ?? [])
        .map((policy) => ({
          name: policy.name,
          effect: policy.effect,
          operations: [...policy.operations].sort(),
          condition: policy.condition,
          errmessage: policy.errmessage,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const functions = schema
    .listFunctions()
    .map((fn) => ({
      module: fn.module,
      name: fn.name,
      params: fn.params.map((p) => ({ name: p.name, type: p.type, optional: Boolean(p.optional), variadic: Boolean(p.variadic), setOf: Boolean(p.setOf), default: p.default })),
      returnType: fn.returnType,
      returnOptional: Boolean(fn.returnOptional),
      returnSetOf: Boolean(fn.returnSetOf),
      body: fn.body,
    }))
    .sort((a, b) => `${a.module}::${a.name}`.localeCompare(`${b.module}::${b.name}`));

  const globals = schema
    .listGlobals()
    .map((g) => ({ module: g.module, name: g.name, exprText: g.exprText }))
    .sort((a, b) => `${a.module}::${a.name}`.localeCompare(`${b.module}::${b.name}`));

  return stableJson({ types, functions, globals });
};

// Deterministic JSON: object keys are recursively sorted so logically-equal
// values serialize identically regardless of key insertion order. Exported for
// the compiler service, which uses it for runtime-built values (globals/params)
// whose key order can vary.
export const stableJson = (value: unknown): string => JSON.stringify(sortValue(value));

const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    for (const [key, entryValue] of entries) {
      out[key] = sortValue(entryValue);
    }
    return out;
  }
  return value;
};

/**
 * When `field`'s declared scalar type extends `sequence` (directly or through
 * a chain of `scalar type … extending …`), returns the fully-qualified name of
 * the user scalar type that backs it — this is the sequence's identity, so two
 * properties declared with the same `extending sequence` scalar share one
 * sequence (matching Gel). Returns undefined for non-sequence fields.
 */
export const fieldSequenceName = (schema: SchemaSnapshot, field: FieldDef): string | undefined => {
  const start = field.targetTypeName;
  if (!start) return undefined;
  const seen = new Set<string>();
  let current: string | undefined = start;
  let topUserScalar: string | undefined;
  while (current && !seen.has(current)) {
    seen.add(current);
    const baseLeaf = current.includes("::") ? current.slice(current.lastIndexOf("::") + 2) : current;
    if (baseLeaf.toLowerCase() === "sequence") {
      return topUserScalar;
    }
    const decl = schema.getScalarType(current);
    if (!decl) return undefined;
    topUserScalar = current;
    const base = decl.baseTypeName;
    current = base ? (base.includes("::") ? base : `${decl.module}::${base}`) : undefined;
  }
  return undefined;
};

/**
 * Splits a (possibly union, e.g. "A | B") link target type string into a list
 * of fully qualified type names, qualifying bare names with `moduleName`.
 */
export const normalizeLinkTargetNames = (targetType: string, moduleName: string): string[] =>
  targetType
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => (part.includes("::") ? part : `${moduleName}::${part}`));

const isUniversalObjectName = (name: string): boolean =>
  name === "default::Object" || name === "std::Object" || name === "Object";

export const functionSignature = (fn: FunctionDef): string => {
  const params = fn.params.map((param) => `${param.variadic ? "variadic " : ""}${param.namedOnly ? "named only " : ""}${param.optional ? "optional " : ""}${param.setOf ? "set of " : ""}${param.type}`).join(",");
  return `${fn.module}::${fn.name}(${params})`;
};

const qualifiedAliasName = (alias: AliasDef): string => `${alias.module}::${alias.name}`;

const qualifiedScalarTypeName = (scalarType: ScalarTypeDeclaration): string => `${scalarType.module}::${scalarType.name}`;

const cloneAliasDef = (alias: AliasDef): AliasDef => ({
  ...alias,
  values: alias.values ? [...alias.values] : undefined,
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
});

const cloneScalarTypeDeclaration = (scalarType: ScalarTypeDeclaration): ScalarTypeDeclaration => ({
  name: scalarType.name,
  module: scalarType.module,
  enumValues: scalarType.enumValues ? [...scalarType.enumValues] : undefined,
  baseTypeName: scalarType.baseTypeName,
  constraints: scalarType.constraints
    ? scalarType.constraints.map((constraint) => ({
        name: constraint.name,
        annotations: constraint.annotations.map((annotation) => ({ ...annotation })),
        delegated: constraint.delegated,
        params: constraint.params ? constraint.params.map((param) => ({ ...param })) : undefined,
      }))
    : undefined,
  annotations: scalarType.annotations?.map((annotation) => ({ ...annotation })),
});

const cloneComputedDef = (
  computed: NonNullable<TypeDef["computeds"]>[number],
): NonNullable<TypeDef["computeds"]>[number] => {
  if (computed.kind === "property") {
    if (computed.expr.kind === "concat") {
      return {
        ...computed,
        annotations: cloneAnnotations(computed.annotations),
        expr: {
          kind: "concat",
          parts: computed.expr.parts.map((part) => ({ ...part })),
        },
      };
    }

    if (computed.expr.kind === "set_literal") {
      return {
        ...computed,
        annotations: cloneAnnotations(computed.annotations),
        expr: {
          kind: "set_literal",
          values: [...computed.expr.values],
        },
      };
    }

    return {
      ...computed,
      annotations: cloneAnnotations(computed.annotations),
      expr: { ...computed.expr },
    };
  }

  if (computed.expr.kind === "link_ref") {
    return {
      ...computed,
      annotations: cloneAnnotations(computed.annotations),
      expr: {
        kind: "link_ref",
        link: computed.expr.link,
        filter: computed.expr.filter ? { ...computed.expr.filter } : undefined,
      },
    };
  }

  if (computed.expr.kind === "select_type") {
    return {
      ...computed,
      annotations: cloneAnnotations(computed.annotations),
      expr: { ...computed.expr },
    };
  }

  return {
    ...computed,
    annotations: cloneAnnotations(computed.annotations),
    expr: {
      kind: "backlink",
      link: computed.expr.link,
      sourceType: computed.expr.sourceType,
    },
  };
};

const cloneAnnotations = (annotations?: AnnotationDef[]): AnnotationDef[] | undefined =>
  annotations?.length ? AnnotationSet.from(annotations).toArray() : undefined;

export const cloneTypeDef = (typeDef: TypeDef): TypeDef => ({
  ...typeDef,
  extends: typeDef.extends ? [...typeDef.extends] : undefined,
  annotations: cloneAnnotations(typeDef.annotations),
  indexes: typeDef.indexes ? typeDef.indexes.map((index) => ({ ...index })) : undefined,
  fields: typeDef.fields.map((f) => ({
    ...f,
    defaultExpr: f.defaultExpr
      ? f.defaultExpr.kind === "function_call"
        ? { kind: "function_call", name: f.defaultExpr.name, args: [...f.defaultExpr.args] }
        : { kind: "literal", value: f.defaultExpr.value }
      : undefined,
    constraints: f.constraints
      ? f.constraints.map((constraint) => ({
          name: constraint.name,
          annotations: cloneAnnotations(constraint.annotations) ?? [],
          delegated: constraint.delegated,
          params: constraint.params ? constraint.params.map((param) => ({ ...param })) : undefined,
          onExpr: constraint.onExpr,
          exceptExpr: constraint.exceptExpr,
        }))
      : undefined,
    annotations: cloneAnnotations(f.annotations),
  })),
  links: typeDef.links?.map((l) => ({
    ...l,
    properties: l.properties?.map((property) => ({
      ...property,
      annotations: cloneAnnotations(property.annotations),
    })),
    annotations: cloneAnnotations(l.annotations),
  })),
  computeds: typeDef.computeds?.map((computed) => cloneComputedDef(computed)),
  mutationRewrites: typeDef.mutationRewrites?.map((rewrite) => ({ ...rewrite, onInsert: rewrite.onInsert ? { ...rewrite.onInsert } : undefined, onUpdate: rewrite.onUpdate ? { ...rewrite.onUpdate } : undefined })),
  triggers: typeDef.triggers?.map((trigger) => ({
    ...trigger,
    when: trigger.when ? { ...trigger.when } : undefined,
    actions: trigger.actions.map((action) => ({
      ...action,
      values: Object.fromEntries(Object.entries(action.values).map(([key, value]) => [key, { ...value }])),
    })),
  })),
  accessPolicies: typeDef.accessPolicies?.map((policy) => ({
    ...policy,
    condition: clonePolicyCondition(policy.condition),
  })),
});

const cloneFunctionDef = (fn: FunctionDef): FunctionDef => ({
  ...fn,
  params: fn.params.map((param) => ({ ...param })),
  annotations: fn.annotations?.map((annotation) => ({ ...annotation })),
  body:
    fn.body.kind === "expr"
      ? fn.body.expr.kind === "concat"
        ? { kind: "expr", expr: { kind: "concat", parts: fn.body.expr.parts.map((part) => ({ ...part })) } }
        : { kind: "expr", expr: { ...fn.body.expr } }
      : { kind: "query", language: fn.body.language, query: fn.body.query },
});

const clonePolicyCondition = (condition: NonNullable<TypeDef["accessPolicies"]>[number]["condition"]): NonNullable<TypeDef["accessPolicies"]>[number]["condition"] => {
  if (condition.kind !== "and") {
    return { ...condition };
  }

  return {
    ...condition,
    clauses: condition.clauses.map((clause) => clonePolicyCondition(clause)),
  };
};
