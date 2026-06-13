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
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  // Asymmetric matchers (`expect.any`, `expect.objectContaining`, …) carry an
  // `asymmetricMatch` method; treat them as opaque values so callers fall
  // through to a plain `toEqual` rather than recursing into matcher internals.
  if (typeof (value as { asymmetricMatch?: unknown }).asymmetricMatch === "function") {
    return false;
  }
  return true;
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
// Port of the Python harness's default float comparison: assert_data_shape
// compares every float shape with math.isclose(rel_tol=1e-04, abs_tol=1e-15).
// Integer-valued pairs keep exact int semantics (Python int shapes compare
// with ==).
const DEFAULT_REL_TOL = 1e-4;
const DEFAULT_ABS_TOL = 1e-15;
function numbersClose(actual: number, expected: number): boolean {
  if (Number.isInteger(actual) && Number.isInteger(expected)) {
    return actual === expected;
  }
  return Math.abs(actual - expected)
    <= Math.max(DEFAULT_REL_TOL * Math.max(Math.abs(actual), Math.abs(expected)), DEFAULT_ABS_TOL);
}

function normalizeAgainstTemplate(actual: unknown, expected: unknown): unknown {
  // Mirror expectLike's scalar-type placeholders: any value of the matching
  // runtime type in actual matches.
  if (expected === "str" && typeof actual === "string") {
    return "str";
  }
  // Snap float-close actuals onto the template value (Python isclose default).
  if (typeof expected === "number" && typeof actual === "number"
      && numbersClose(actual, expected)) {
    return expected;
  }
  if ((expected === "int" || expected === "float" || expected === "decimal")
      && typeof actual === "number") {
    return expected;
  }
  if (expected === "bool" && typeof actual === "boolean") {
    return "bool";
  }
  if (isUnorderedBag(expected) || isUnorderedSet(expected)) {
    // The engine sometimes returns set-typed values pre-wrapped as
    // `{__kind: "set", items: [...]}` — unwrap so we don't double-wrap.
    const actualItems = isUnorderedBag(actual) || isUnorderedSet(actual)
      ? (actual.items as unknown[])
      : Array.isArray(actual) ? actual : [actual];
    // Pick the best-matching template per item rather than pairing by array
    // index: bag/set results come back in arbitrary order (e.g. multi-link
    // rows ordered by random ids), so index-based pairing nondeterministically
    // projects an item onto the wrong template's keys (nulling out the fields
    // the right template asked for). Prefer a template whose normalized form
    // matches it exactly; otherwise fall back to the first template.
    const templates = expected.items as unknown[];
    const templateKeys = templates.map((t) => canonical(t));
    const normalizedItems = actualItems.map((item) => {
      let fallback: unknown = item;
      for (let j = 0; j < templates.length; j++) {
        const normalized = normalizeAgainstTemplate(item, templates[j]);
        if (canonical(normalized) === templateKeys[j]) {
          return normalized;
        }
        if (j === 0) fallback = normalized;
      }
      return fallback;
    });
    normalizedItems.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { __kind: "_unordered", items: normalizedItems };
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    return actual.map((item, i) => normalizeAgainstTemplate(item, expected[i]));
  }
  if (isPlainObject(expected) && isPlainObject(actual)) {
    // Match Python's `assert_query_result` semantics: only the keys named in
    // `expected` are compared, so actual rows with additional fields (e.g.
    // GROUP's `grouping` field when the test only checks `key`/`elements`)
    // still match.
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(expected).sort()) {
      if (Object.prototype.hasOwnProperty.call(actual, key)) {
        out[key] = normalizeAgainstTemplate(actual[key], expected[key]);
      }
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

export type AssertOptions = { absTol?: number };

// Mirror of Python's assert_query_result(..., abs_tol=...): numeric leaves
// compare within the tolerance instead of exactly. Sets/bags of numbers are
// matched by sorting both sides numerically and pairing in order.
function expectLikeTol(actual: unknown, expected: unknown, absTol: number): void {
  if (isUnorderedBag(expected) || isUnorderedSet(expected)) {
    expect(Array.isArray(actual)).toBe(true);
    const actualArray = [...(actual as unknown[])];
    const expectedItems = [...(expected as UnorderedBag | UnorderedSet).items];
    expect(actualArray.length).toBe(expectedItems.length);
    const allNumbers = (xs: unknown[]) => xs.every((x) => typeof x === "number");
    if (allNumbers(actualArray) && allNumbers(expectedItems)) {
      (actualArray as number[]).sort((a, b) => a - b);
      (expectedItems as number[]).sort((a, b) => a - b);
    }
    for (let i = 0; i < expectedItems.length; i++) {
      expectLikeTol(actualArray[i], expectedItems[i], absTol);
    }
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual)).toBe(true);
    const actualArray = actual as unknown[];
    expect(actualArray.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expectLikeTol(actualArray[i], expected[i], absTol);
    }
    return;
  }
  if (typeof expected === "number" && typeof actual === "number") {
    if (Math.abs(actual - expected) > absTol) {
      expect(actual).toEqual(expected);
    }
    return;
  }
  expectLike(actual, expected);
}

export function expectLike(actual: unknown, expected: unknown): void {
  if (isUnorderedBag(expected)) {
    expect(Array.isArray(actual)).toBe(true);
    const actualArray = actual as unknown[];

    // Always normalize each actual item against the best-matching expected
    // template before computing the canonical key. This lets template-side
    // placeholders ("str"), unordered-wrapped fields, and missing-extra-keys
    // semantics carry through into the bag comparison.
    const expectedCounts = new Map<string, number>();
    for (const item of expected.items) {
      const key = canonical(item);
      expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
    }

    const actualCounts = new Map<string, number>();
    for (const item of actualArray) {
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
      const key = bestKey ?? canonical(item);
      actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1);
    }

    expect(actualCounts).toEqual(expectedCounts);
    return;
  }

  if (isUnorderedSet(expected)) {
    expect(Array.isArray(actual)).toBe(true);
    const expectedSet = new Set(expected.items.map(canonical));
    // Normalize each actual item against the best-matching template so
    // float-closeness and placeholder semantics apply inside sets too.
    const actualSet = new Set((actual as unknown[]).map((item) => {
      for (const tmpl of expected.items) {
        const candidate = canonical(normalizeAgainstTemplate(item, tmpl));
        if (expectedSet.has(candidate)) return candidate;
      }
      return canonical(item);
    }));
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
  // `'UUID'` is upstream's sentinel for "any UUID string" — matches either the
  // canonical dashed form or the dashless 32-hex form this engine emits.
  if (expected === "UUID" && typeof actual === "string"
      && /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(actual)) {
    return;
  }
  if ((expected === "int" || expected === "float" || expected === "decimal")
      && typeof actual === "number") {
    return;
  }
  if (expected === "bool" && typeof actual === "boolean") {
    return;
  }
  if (typeof expected === "number" && typeof actual === "number"
      && numbersClose(actual, expected)) {
    return;
  }

  expect(actual).toEqual(expected);
}

export function assertQueryResult(
  h: QueryHarness,
  query: string,
  expected: unknown,
  options?: AssertOptions,
): void {
  const result = h.query(query);
  const normalized =
    result && typeof result === "object" && "rows" in (result as unknown as Record<string, unknown>)
      ? (result as { rows: unknown }).rows
      : result;

  if (options?.absTol !== undefined) {
    expectLikeTol(normalized, expected, options.absTol);
    return;
  }
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
