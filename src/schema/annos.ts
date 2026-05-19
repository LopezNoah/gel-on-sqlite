import type { SQLiteDatabase } from "../runtime/database.js";
import type { AnnotationDef, AbstractAnnotationDef } from "../types.js";
import type { AnnotationMetadata } from "./gel_metadata_schemas.js";
import * as errors from "./errors.js";

const STANDARD_ANNOTATIONS = new Map<string, boolean>([
  ["std::title", false],
  ["std::description", false],
  ["std::deprecated", false],
]);

const STANDARD_ANNOTATION_IDENTIFIERS = new Set(["title", "description", "deprecated"]);

export const normalizeAnnotationName = (moduleName: string, name: string): string => {
  if (name.includes("::")) {
    return name;
  }

  if (STANDARD_ANNOTATION_IDENTIFIERS.has(name)) {
    return `std::${name}`;
  }

  return `${moduleName}::${name}`;
};

export class AnnotationRegistry {
  private readonly definitions = new Map<string, boolean>(STANDARD_ANNOTATIONS);
  private readonly pendingNested = new Map<string, AbstractAnnotationDef>();

  constructor(abstractAnnotations: AbstractAnnotationDef[] = []) {
    for (const annotation of abstractAnnotations) {
      this.register(annotation);
    }
    this.validatePending();
  }

  register(annotation: AbstractAnnotationDef): void {
    // EdgeDB annotations must have a name
    if (!annotation.name) {
      throw new errors.InternalServerError("Annotation definition missing name");
    }

    this.definitions.set(annotation.name, Boolean(annotation.inheritable));
    if ((annotation.annotations?.length ?? 0) > 0) {
      this.pendingNested.set(annotation.name, annotation);
    }
  }

  validatePending(): void {
    for (const entry of this.pendingNested.values()) {
      for (const nested of entry.annotations ?? []) {
        this.ensureKnown(nested.name, `abstract annotation ${entry.name}`);
      }
    }
    this.pendingNested.clear();
  }

  ensureKnown(name: string, context: string): void {
    if (!this.definitions.has(name)) {
      // Matches logic in Python when an annotation is referenced but not defined
      throw new errors.SchemaDefinitionError(
        `Unknown annotation '${name}' in ${context}`
      );
    }
  }

  isInheritable(name: string): boolean {
    return this.definitions.get(name) ?? false;
  }
}

export class AnnotationSet {
  private readonly annotations = new Map<string, AnnotationDef>();

  constructor(initial: AnnotationDef[] = []) {
    for (const annotation of initial) {
      // Python CreateAnnotationValue check: Annotation values must be strings
      if (typeof annotation.value !== "string") {
        throw new errors.InvalidValueError(
          `annotation values must be 'std::str', got ${typeof annotation.value}`
        );
      }
      this.annotations.set(annotation.name, { ...annotation });
    }
  }

  static from(annotations: AnnotationDef[] = []): AnnotationSet {
    return new AnnotationSet(annotations);
  }

  // Implementation of Python's AnnotationSubject.must_get_annotation
  mustGet(name: string, context: string): string {
    const anno = this.annotations.get(name);
    if (!anno) {
      throw new errors.SchemaDefinitionError(
        `annotation ${name} on ${context} is not set`
      );
    }
    return anno.value;
  }

  // Implementation of Python's AnnotationSubject.get_json_annotation
  getJson<T>(
    name: string, 
    context: string, 
    validator: (val: unknown) => T
  ): T | undefined {
    const anno = this.annotations.get(name);
    if (!anno) return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(anno.value);
    } catch {
      throw new errors.SchemaDefinitionError(
        `annotation ${name} on ${context} is not set to a valid JSON value`
      );
    }

    try {
      return validator(parsed);
    } catch (error) {
      throw new errors.SchemaDefinitionError(
        `annotation ${name} on ${context} is not set to JSON containing a valid value: ${error}`
      );
    }
  }

  // Implementation of Python's AnnotationSubject.must_get_json_annotation
  mustGetJson<T>(
    name: string, 
    context: string, 
    validator: (val: unknown) => T
  ): T {
    const value = this.getJson(name, context, validator);
    if (value === undefined) {
      throw new errors.SchemaDefinitionError(
        `annotation ${name} is not set on ${context}`
      );
    }
    return value;
  }

  clone(): AnnotationSet {
    return new AnnotationSet(this.toArray());
  }

  toArray(): AnnotationDef[] {
    return [...this.annotations.values()].map((annotation) => ({ ...annotation }));
  }

  merge(other: AnnotationSet): AnnotationSet {
    const merged = this.clone();
    for (const annotation of other.annotations.values()) {
      merged.annotations.set(annotation.name, { ...annotation });
    }
    return merged;
  }

  inherit(registry: AnnotationRegistry): AnnotationSet {
    const filtered = [...this.annotations.values()].filter((annotation) => 
      registry.isInheritable(annotation.name)
    );
    return new AnnotationSet(filtered);
  }

  ensureValid(registry: AnnotationRegistry, context: string): void {
    for (const annotation of this.annotations.values()) {
      registry.ensureKnown(annotation.name, context);
    }
  }
}

type QualifiedNameGetter<T> = (decl: T) => string;
type DeclarationLookup<T> = (qualifiedName: string) => T | undefined;

export class AnnotationResolver<T extends { extends?: string[]; annotations?: AnnotationDef[] }> {
  private readonly cache = new Map<string, AnnotationSet>();

  constructor(
    private readonly registry: AnnotationRegistry,
    private readonly qualifier: QualifiedNameGetter<T>,
    private readonly lookup: DeclarationLookup<T>,
  ) {}

  resolve(declaration: T, stack = new Set<string>()): AnnotationSet {
    const qualifiedName = this.qualifier(declaration);
    if (stack.has(qualifiedName)) {
      return new AnnotationSet();
    }

    if (this.cache.has(qualifiedName)) {
      return this.cache.get(qualifiedName)!.clone();
    }

    stack.add(qualifiedName);

    let inherited = new AnnotationSet();
    for (const baseName of declaration.extends ?? []) {
      const base = this.lookup(baseName);
      if (!base) {
        // Matches standard EdgeDB "Unknown base" error logic
        throw new errors.SchemaError(
          `Unknown base type '${baseName}' in ${qualifiedName}`
        );
      }
      const baseAnnotations = this.resolve(base, stack).inherit(this.registry);
      inherited = inherited.merge(baseAnnotations);
    }

    stack.delete(qualifiedName);

    const own = AnnotationSet.from(declaration.annotations ?? []);
    own.ensureValid(this.registry, qualifiedName);

    const resolved = inherited.merge(own);
    this.cache.set(qualifiedName, resolved.clone());
    return resolved;
  }
}

export interface AnnotationRow {
  subject_id: string;
  annotation_id: string;
  value: string | null;
}

export const buildAnnotationsBySubject = (rows: AnnotationRow[]): Map<string, AnnotationRow[]> => {
  const map = new Map<string, AnnotationRow[]>();
  for (const row of rows) {
    if (!map.has(row.subject_id)) {
      map.set(row.subject_id, []);
    }
    map.get(row.subject_id)!.push(row);
  }
  return map;
};

export const resolveAnnotations = (
  subjectId: string,
  annotationsBySubject: Map<string, AnnotationRow[]>,
  idToRow: Map<string, { name: string }>,
): AnnotationDef[] =>
  (annotationsBySubject.get(subjectId) ?? [])
    .map((entry) => {
      const annotationRow = idToRow.get(entry.annotation_id);
      if (!annotationRow) {
        return null;
      }
      return { name: annotationRow.name, value: entry.value ?? "" };
    })
    .filter((annotation): annotation is AnnotationDef => annotation !== null);

export const insertAnnotationRecord = (
  db: SQLiteDatabase,
  subjectId: string,
  annotation: AnnotationDef,
  moduleName: string,
  internalName: string,
): void => {
  const annotationId = `ann_${subjectId}_${annotation.name}`;
  db.prepare(
    `INSERT INTO gel_schema (id, kind, name, name__internal, module, abstract, builtin, internal, parent_ids, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    annotationId,
    "Annotation",
    annotation.name,
    internalName,
    moduleName,
    0,
    0,
    0,
    null,
    JSON.stringify({ inheritable: false } satisfies AnnotationMetadata),
  );
  db.prepare(`INSERT INTO gel_annotations (subject_id, annotation_id, value) VALUES (?, ?, ?)`).run(
    subjectId,
    annotationId,
    annotation.value,
  );
};
