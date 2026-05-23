import fs from 'node:fs';
import path from 'node:path';
import { openSQLite, materializeSchema } from './src/runtime/database.js';
import { parseDeclarativeSchema } from './src/schema/sdl_adapter.js';
import { schemaSnapshotFromDeclarative } from './src/schema/uiSchema.js';
import { executeScript, executeQuery } from './src/runtime/engine.js';
import {
  ensureGelSchemaTables,
  serializeSchemaToGelTables,
  serializeSchemaToInstdata,
} from './src/schema/gel_persistence.js';
import { parseEdgeQL } from './src/edgeql/parser.js';

const stripHashComments = (source: string): string => source.replace(/^\s*#.*$/gm, '');

(async () => {
  const cwd = process.cwd();
  const schemaDir = path.join(cwd, 'tests/schemas');
  const schemaBody = stripHashComments(fs.readFileSync(path.join(schemaDir, 'cards.esdl'), 'utf8'));
  const wrapped = schemaBody.trimStart().startsWith('module ')
    ? schemaBody
    : `module default {\n${schemaBody}\n}`;
  const decl = parseDeclarativeSchema(wrapped, { legacySyntaxCompat: true });
  const snapshot = schemaSnapshotFromDeclarative(decl);
  const { db } = openSQLite(':memory:');
  materializeSchema(db, snapshot);
  ensureGelSchemaTables(db);
  serializeSchemaToGelTables(db, snapshot);
  serializeSchemaToInstdata(db, snapshot);

  console.log('=== AST for SELECT User.<owners ===');
  console.dir(parseEdgeQL(`SELECT User.<owners`), { depth: null });

  try {
    const r = executeQuery(db, snapshot, `SELECT User.<owners`);
    console.log('result:', r);
  } catch (e: any) {
    console.log('error:', e.message);
  }
})().catch((err) => { console.error(err); process.exit(1); });
