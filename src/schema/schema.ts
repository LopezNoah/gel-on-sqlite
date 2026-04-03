import type { FieldDef, FunctionDef, TypeDef } from "../types.js";

export interface SchemaDelta {
  createTypes?: TypeDef[];
  addFields?: Array<{ typeName: string; field: FieldDef }>;
}

export class SchemaSnapshot {
  private readonly typesByName: Map<string, TypeDef>;
  private readonly functionsBySignature: Map<string, FunctionDef>;

  constructor(types: TypeDef[] = [], functions: FunctionDef[] = []) {
    this.typesByName = new Map(types.map((t) => [qualifiedTypeName(t), cloneTypeDef(t)]));
    this.functionsBySignature = new Map(functions.map((fn) => [functionSignature(fn), cloneFunctionDef(fn)]));
  }

  getType(name: string): TypeDef | undefined {
    const existing = this.typesByName.get(name);
    return existing ? cloneTypeDef(existing) : undefined;
  }

  listTypes(): TypeDef[] {
    return [...this.typesByName.values()].map(cloneTypeDef);
  }

  getFunction(signature: string): FunctionDef | undefined {
    const existing = this.functionsBySignature.get(signature);
    return existing ? cloneFunctionDef(existing) : undefined;
  }

  findFunction(moduleName: string, name: string, arity: number): FunctionDef | undefined {
    for (const fn of this.functionsBySignature.values()) {
      if (fn.module !== moduleName || fn.name !== name) {
        continue;
      }

      const requiredCount = fn.params.filter((param) => !param.optional && param.default === undefined && !param.variadic).length;
      const accepts = arity >= requiredCount && (fn.params.some((param) => param.variadic) || arity <= fn.params.length);
      if (accepts) {
        return cloneFunctionDef(fn);
      }
    }

    return undefined;
  }

  listFunctions(): FunctionDef[] {
    return [...this.functionsBySignature.values()].map(cloneFunctionDef);
  }

  listConcreteTypesAssignableTo(name: string): TypeDef[] {
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

    return new SchemaSnapshot([...next.values()], this.listFunctions());
  }
}

export const qualifiedTypeName = (typeDef: TypeDef): string => {
  const module = typeDef.module ?? "default";
  return `${module}::${typeDef.name}`;
};

export const functionSignature = (fn: FunctionDef): string => {
  const params = fn.params.map((param) => `${param.variadic ? "variadic " : ""}${param.namedOnly ? "named only " : ""}${param.optional ? "optional " : ""}${param.setOf ? "set of " : ""}${param.type}`).join(",");
  return `${fn.module}::${fn.name}(${params})`;
};

const cloneComputedDef = (
  computed: NonNullable<TypeDef["computeds"]>[number],
): NonNullable<TypeDef["computeds"]>[number] => {
  if (computed.kind === "property") {
    if (computed.expr.kind === "concat") {
      return {
        ...computed,
        annotations: computed.annotations?.map((annotation) => ({ ...annotation })),
        expr: {
          kind: "concat",
          parts: computed.expr.parts.map((part) => ({ ...part })),
        },
      };
    }

    return {
      ...computed,
      annotations: computed.annotations?.map((annotation) => ({ ...annotation })),
      expr: { ...computed.expr },
    };
  }

  if (computed.expr.kind === "link_ref") {
    return {
      ...computed,
      annotations: computed.annotations?.map((annotation) => ({ ...annotation })),
      expr: {
        kind: "link_ref",
        link: computed.expr.link,
        filter: computed.expr.filter ? { ...computed.expr.filter } : undefined,
      },
    };
  }

  return {
    ...computed,
    annotations: computed.annotations?.map((annotation) => ({ ...annotation })),
    expr: {
      kind: "backlink",
      link: computed.expr.link,
      sourceType: computed.expr.sourceType,
    },
  };
};

const cloneTypeDef = (typeDef: TypeDef): TypeDef => ({
  ...typeDef,
  extends: typeDef.extends ? [...typeDef.extends] : undefined,
  annotations: typeDef.annotations?.map((annotation) => ({ ...annotation })),
  fields: typeDef.fields.map((f) => ({ ...f, annotations: f.annotations?.map((annotation) => ({ ...annotation })) })),
  links: typeDef.links?.map((l) => ({
    ...l,
    properties: l.properties?.map((property) => ({
      ...property,
      annotations: property.annotations?.map((annotation) => ({ ...annotation })),
    })),
    annotations: l.annotations?.map((annotation) => ({ ...annotation })),
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
