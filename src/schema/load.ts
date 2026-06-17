// Schema ingestion facade — the one canonical SDL → SchemaSnapshot entry point.
//
// Turning SDL source into a usable SchemaSnapshot is a two-step chain:
//   SDL text → parseDeclarativeSchema → DeclarativeSchema
//            → schemaSnapshotFromDeclarative → SchemaSnapshot
// That chain was hand-rolled across 20+ call sites (the engine, the HTTP entry,
// every inference test, the test harness, the dev runners). `loadSchema` is the
// single home for it, so callers depend on one interface and the conversion web
// (see CONTEXT.md "Schema representations") stays implementation detail.

import { parseDeclarativeSchema, type NewSDLAdapterOptions } from "./sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "./uiSchema.js";
import type { SchemaSnapshot } from "./schema.js";

/**
 * Parse declarative SDL `source` and build the immutable SchemaSnapshot.
 * `source` is raw SDL (module-wrapped as the caller needs); options forward to
 * the SDL parser (`legacySyntaxCompat`, etc.).
 */
export const loadSchema = (
  source: string,
  options: NewSDLAdapterOptions,
): SchemaSnapshot => schemaSnapshotFromDeclarative(parseDeclarativeSchema(source, options));
