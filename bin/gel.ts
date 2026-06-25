#!/usr/bin/env -S npx tsx
//
// gel-sqlite — schema-sync + migration CLI for the sqlite-ts engine.
//
//   gel push        diff schema files against the live DB and apply directly
//   gel status      show pending schema changes (exits 1 if any — CI-friendly)
//   gel generate    write a migration file for the current schema delta
//   gel migrate     apply pending migration files to the DB
//   gel codegen     generate typed TS query functions from .edgeql files
//
// Conventions (override with flags):
//   --schema <dir>      schema directory      (default: dbschema)
//   --db <file>         sqlite database file  (default: $SQLITE_FILE or ./local.db)
//   --migrations <dir>  migrations directory  (default: <schema>/migrations)
//   --name <name>       migration name        (generate; default: migration)
//   --queries <dir>     .edgeql directory     (codegen; default: queries)
//   --out <file>        codegen output file   (codegen; default: <queries>/queries.ts)

import path from "node:path";
import { openSQLite } from "../src/runtime/database.js";
import { readSchemaSource } from "../src/migrate/schema_source.js";
import { generate, migrate, push, status } from "../src/migrate/migrator.js";
import { generateQueryClient } from "../src/codegen/queries.js";

interface Options {
  schema: string;
  db: string;
  migrations: string;
  name: string;
  queries: string;
  out?: string;
}

const parseArgs = (argv: string[]): { command: string; options: Options } => {
  const command = argv[0] ?? "help";
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      flags.set(key, value);
    } else {
      positionals.push(token);
    }
  }
  const schema = flags.get("schema") ?? "dbschema";
  const queries = flags.get("queries") ?? "queries";
  return {
    command,
    options: {
      schema,
      db: flags.get("db") ?? process.env.SQLITE_FILE ?? "local.db",
      migrations: flags.get("migrations") ?? path.join(schema, "migrations"),
      // `generate <name>` (positional) or `generate --name <name>`.
      name: flags.get("name") ?? positionals[0] ?? "migration",
      queries,
      out: flags.get("out"),
    },
  };
};

const readTarget = (schemaDir: string): string => {
  const { files, source } = readSchemaSource(schemaDir);
  if (files.length === 0) {
    fail(`no .esdl/.gel schema files found under '${schemaDir}' (use --schema <dir>)`);
  }
  return source;
};

const fail = (message: string): never => {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
};

const HELP = `gel-sqlite — schema + migration CLI

Usage: gel <command> [options]

Commands:
  push        Diff schema files against the DB and apply directly (no files)
  status      Show pending schema changes; exits 1 if any
  generate [name]   Write a migration file for the current schema delta
  migrate     Apply pending migration files to the DB
  codegen     Generate typed TS query functions from .edgeql files

Options:
  --schema <dir>      schema directory      (default: dbschema)
  --db <file>         sqlite database file  (default: $SQLITE_FILE or local.db)
  --migrations <dir>  migrations directory  (default: <schema>/migrations)
  --name <name>       migration name        (generate)
  --queries <dir>     .edgeql directory     (codegen; default: queries)
  --out <file>        codegen output        (codegen; default: <queries>/queries.ts)
`;

const main = (): void => {
  const { command, options } = parseArgs(process.argv.slice(2));

  switch (command) {
    case "push": {
      const target = readTarget(options.schema);
      const { db } = openSQLite(options.db);
      const res = push(db, target);
      if (res.status === "created") {
        process.stdout.write(`✓ created schema in ${options.db}\n`);
      } else if (res.status === "in-sync") {
        process.stdout.write(`✓ already in sync — nothing to apply\n`);
      } else {
        process.stdout.write(`✓ applied ${res.stepCount} change(s) to ${options.db}\n`);
      }
      return;
    }

    case "status": {
      const target = readTarget(options.schema);
      const { db } = openSQLite(options.db);
      const res = status(db, target);
      if (!res.hasChanges) {
        process.stdout.write(`✓ in sync — no pending schema changes\n`);
        return;
      }
      process.stdout.write(`pending schema changes:\n\n${res.sql}\n`);
      process.exit(1);
    }

    case "generate": {
      const target = readTarget(options.schema);
      const res = generate(options.migrations, target, options.name);
      if (res.status === "no-changes") {
        process.stdout.write(`✓ no schema changes — nothing to generate\n`);
        return;
      }
      process.stdout.write(`✓ generated ${res.id} (${res.stepCount} step(s))\n  ${res.sqlFile}\n`);
      return;
    }

    case "migrate": {
      const { db } = openSQLite(options.db);
      const res = migrate(db, options.migrations);
      if (res.applied.length === 0) {
        process.stdout.write(`✓ up to date (${res.alreadyApplied} migration(s) already applied)\n`);
        return;
      }
      process.stdout.write(`✓ applied ${res.applied.length} migration(s):\n`);
      for (const id of res.applied) process.stdout.write(`  - ${id}\n`);
      return;
    }

    case "codegen": {
      const target = readTarget(options.schema);
      const out = options.out ?? path.join(options.queries, "queries.ts");
      const res = generateQueryClient({ schemaSource: target, queriesDir: options.queries, outFile: out });
      if (res.generated === 0) {
        process.stdout.write(`no .edgeql files found under '${options.queries}'\n`);
        return;
      }
      process.stdout.write(`✓ generated ${res.generated} query function(s) → ${out}\n`);
      for (const w of res.warnings) process.stderr.write(`  warning: ${w}\n`);
      return;
    }

    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;

    default:
      process.stderr.write(`unknown command '${command}'\n\n${HELP}`);
      process.exit(1);
  }
};

main();
