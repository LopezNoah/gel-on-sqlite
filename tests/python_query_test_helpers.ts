import { expect } from "vitest";
import type { QueryHarness } from "./utils.js";

export type UnorderedBag = { __kind: "bag"; items: unknown[] };
export type UnorderedSet = { __kind: "set"; items: unknown[] };

export function unorderedBag(items: unknown[]): UnorderedBag {
  return { __kind: "bag", items };
}

export function unorderedSet(items: unknown[]): UnorderedSet {
  return { __kind: "set", items };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stable(value: unknown): unknown {
  // Normalize the unorderedBag / unorderedSet wrappers so their canonical form
  // doesn't depend on item order or on whether the actual side uses the wrapper.
  if (isPlainObject(value) && "__kind" in value) {
    const kind = (value as { __kind?: unknown }).__kind;
    if (kind === "bag" || kind === "set") {
      const items = ((value as { items?: unknown[] }).items ?? []).map(stable);
      items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return { __kind: kind === "set" ? "_unordered" : "_unordered", items };
    }
  }
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = stable(value[key]);
    }
    return out;
  }
  return value;
}

function canonical(value: unknown): string {
  return JSON.stringify(stable(value));
}

// Recursively normalize an "actual" value to match how an `expected` template
// uses unorderedSet/unorderedBag wrappers — sorting array elements where the
// template expects unordered matching. Returns a value whose canonical form is
// directly comparable with the expected side.
function normalizeAgainstTemplate(actual: unknown, expected: unknown): unknown {
  if (isUnorderedBag(expected) || isUnorderedSet(expected)) {
    // The engine sometimes returns set-typed values pre-wrapped as
    // `{__kind: "set", items: [...]}` — unwrap so we don't double-wrap.
    const actualItems = isUnorderedBag(actual) || isUnorderedSet(actual)
      ? (actual.items as unknown[])
      : Array.isArray(actual) ? actual : [actual];
    const normalizedItems = actualItems.map((item, i) => {
      const template = (expected.items as unknown[])[i % expected.items.length];
      return normalizeAgainstTemplate(item, template);
    });
    normalizedItems.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { __kind: "_unordered", items: normalizedItems };
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    return actual.map((item, i) => normalizeAgainstTemplate(item, expected[i]));
  }
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(actual).sort()) {
      out[key] = normalizeAgainstTemplate(actual[key], expected[key]);
    }
    return out;
  }
  return actual;
}

function isUnorderedBag(value: unknown): value is UnorderedBag {
  return isPlainObject(value) && value.__kind === "bag" && Array.isArray(value.items);
}

function isUnorderedSet(value: unknown): value is UnorderedSet {
  return isPlainObject(value) && value.__kind === "set" && Array.isArray(value.items);
}

function templateContainsUnordered(value: unknown): boolean {
  if (isUnorderedBag(value) || isUnorderedSet(value)) return true;
  if (Array.isArray(value)) return value.some(templateContainsUnordered);
  if (isPlainObject(value)) {
    return Object.values(value).some(templateContainsUnordered);
  }
  return false;
}

export function expectLike(actual: unknown, expected: unknown): void {
  if (isUnorderedBag(expected)) {
    expect(Array.isArray(actual)).toBe(true);
    const actualArray = actual as unknown[];

    // When the expected items are heterogeneous (e.g. a bag of objects whose
    // fields use unorderedSet wrappers), the actual items must be normalized
    // against a matching template so their canonical strings line up.
    const anyTemplateUsesUnordered = expected.items.some(templateContainsUnordered);

    const expectedCounts = new Map<string, number>();
    for (const item of expected.items) {
      const key = canonical(item);
      expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
    }

    const actualCounts = new Map<string, number>();
    for (const item of actualArray) {
      let key: string;
      if (anyTemplateUsesUnordered) {
        // Find the expected template whose canonical matches and normalize
        // the actual item against it. Fall back to plain canonical when none
        // matches so we still produce a deterministic, comparable key.
        let bestKey: string | undefined;
        for (const tmpl of expected.items) {
          const normalized = normalizeAgainstTemplate(item, tmpl);
          const candidate = canonical(normalized);
          if (expectedCounts.has(candidate)) {
            bestKey = candidate;
            break;
          }
          if (bestKey === undefined) bestKey = candidate;
        }
        key = bestKey ?? canonical(item);
      } else {
        key = canonical(item);
      }
      actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1);
    }

    expect(actualCounts).toEqual(expectedCounts);
    return;
  }

  if (isUnorderedSet(expected)) {
    expect(Array.isArray(actual)).toBe(true);
    const expectedSet = new Set(expected.items.map(canonical));
    const actualSet = new Set((actual as unknown[]).map(canonical));
    expect(actualSet).toEqual(expectedSet);
    return;
  }

  if (Array.isArray(expected)) {
    expect(Array.isArray(actual)).toBe(true);
    const actualArray = actual as unknown[];
    expect(actualArray.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expectLike(actualArray[i], expected[i]);
    }
    return;
  }

  if (isPlainObject(expected)) {
    expect(isPlainObject(actual)).toBe(true);
    const actualObj = actual as Record<string, unknown>;
    const expectedKeys = Object.keys(expected).sort();
    for (const key of expectedKeys) {
      expect(Object.prototype.hasOwnProperty.call(actualObj, key)).toBe(true);
      expectLike(actualObj[key], expected[key]);
    }
    return;
  }

  if (expected === "str" && typeof actual === "string") {
    return;
  }

  expect(actual).toEqual(expected);
}

export function assertQueryResult(h: QueryHarness, query: string, expected: unknown): void {
  const result = h.query(query);
  const normalized =
    result && typeof result === "object" && "rows" in (result as unknown as Record<string, unknown>)
      ? (result as { rows: unknown }).rows
      : result;

  expectLike(normalized, expected);
}

export function queryRows<T = unknown>(h: QueryHarness, query: string): T[] {
  const result = h.query(query) as unknown;
  if (result && typeof result === "object" && "rows" in (result as Record<string, unknown>)) {
    return ((result as { rows?: T[] }).rows ?? []);
  }
  return Array.isArray(result) ? result as T[] : [result as T];
}

export function querySingle<T = unknown>(h: QueryHarness, query: string): T {
  const [row] = queryRows<T>(h, query);
  return row;
}
