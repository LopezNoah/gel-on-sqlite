// On-disk migration store for the versioned (`generate` + `migrate`) flow.
//
// Layout under <migrationsDir>:
//   0001_init.sql              -- the rendered DDL for humans / raw apply
//   meta/_journal.json         -- ordered index of migrations (id, checksum)
//   meta/0001_init.snapshot.esdl  -- full target SDL at this migration
//
// `migrate` re-derives each step's plan by diffing consecutive snapshots, so the
// checksum recorded in the journal must match the plan computed at apply time —
// that is what guarantees a generated migration applies exactly as authored.

import fs from "node:fs";
import path from "node:path";

export interface JournalEntry {
  idx: number;
  id: string;
  name: string;
  checksum: string;
}

export interface Journal {
  version: 1;
  entries: JournalEntry[];
}

const EMPTY_JOURNAL: Journal = { version: 1, entries: [] };

const metaDir = (migrationsDir: string): string => path.join(migrationsDir, "meta");
const journalPath = (migrationsDir: string): string => path.join(metaDir(migrationsDir), "_journal.json");
const snapshotPath = (migrationsDir: string, idx: number): string =>
  path.join(metaDir(migrationsDir), `${pad(idx)}.snapshot.esdl`);

export const pad = (idx: number): string => String(idx).padStart(4, "0");

export const readJournal = (migrationsDir: string): Journal => {
  const p = journalPath(migrationsDir);
  if (!fs.existsSync(p)) return { ...EMPTY_JOURNAL, entries: [] };
  const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as Journal;
  return { version: 1, entries: parsed.entries ?? [] };
};

export const readSnapshotSource = (migrationsDir: string, idx: number): string => {
  const p = snapshotPath(migrationsDir, idx);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
};

export const nextSeq = (journal: Journal): number =>
  journal.entries.reduce((max, e) => Math.max(max, e.idx), 0) + 1;

export interface WriteMigrationInput {
  idx: number;
  name: string;
  checksum: string;
  sql: string;
  snapshotSource: string;
}

/** Persist one migration: its `.sql`, its SDL snapshot, and a journal entry. */
export const writeMigration = (migrationsDir: string, input: WriteMigrationInput): { id: string; sqlFile: string } => {
  fs.mkdirSync(metaDir(migrationsDir), { recursive: true });
  const id = `${pad(input.idx)}_${input.name}`;
  const sqlFile = path.join(migrationsDir, `${id}.sql`);
  fs.writeFileSync(sqlFile, input.sql.endsWith("\n") ? input.sql : `${input.sql}\n`);
  fs.writeFileSync(snapshotPath(migrationsDir, input.idx), input.snapshotSource);

  const journal = readJournal(migrationsDir);
  journal.entries.push({ idx: input.idx, id, name: input.name, checksum: input.checksum });
  fs.writeFileSync(journalPath(migrationsDir), `${JSON.stringify(journal, null, 2)}\n`);
  return { id, sqlFile };
};
