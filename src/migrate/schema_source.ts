// Multi-file schema discovery for the migration CLI.
//
// Drizzle-style split schemas: a project keeps its SDL across several `.esdl`
// (or `.gel`) files under a schema directory. This module reads them all,
// concatenates them in a deterministic order, and hands the combined source to
// the canonical `parseDeclarativeSchema` / `loadSchema` chain. The combined
// source is the single thing migrations diff against, so the file split is
// purely an authoring convenience — the engine never sees the boundaries.

import fs from "node:fs";
import path from "node:path";

const SCHEMA_EXTENSIONS = new Set([".esdl", ".gel"]);

export interface DiscoveredSchema {
  /** Absolute paths of the schema files, in the order they were concatenated. */
  files: string[];
  /** The concatenated SDL source. */
  source: string;
}

/** Recursively collect schema files under `dir`, sorted for deterministic output. */
export const discoverSchemaFiles = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        // `migrations/` lives under the schema dir by convention; never treat
        // generated migration artifacts as schema input.
        if (entry.name === "migrations" || entry.name === "meta") continue;
        walk(full);
        continue;
      }
      if (SCHEMA_EXTENSIONS.has(path.extname(entry.name))) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
};

/**
 * Read and concatenate all schema files under `dir`. Files are joined with
 * blank lines; each file's content is used verbatim (it may contain its own
 * `module` blocks, or bare top-level declarations that fall into `default`).
 */
export const readSchemaSource = (dir: string): DiscoveredSchema => {
  const files = discoverSchemaFiles(dir);
  const source = files.map((file) => fs.readFileSync(file, "utf-8")).join("\n\n");
  return { files, source };
};
