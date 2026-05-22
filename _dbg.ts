import fs from 'node:fs';
import path from 'node:path';
import { openSQLite, materializeSchema } from './src/runtime/database.js';
import { parseDeclarativeSchema } from './src/schema/sdl_adapter.js';
import { schemaSnapshotFromDeclarative } from './src/schema/uiSchema.js';
import { executeScript, executeQueryWithTrace } from './src/runtime/engine.js';
import {
  ensureGelSchemaTables,
  serializeSchemaToGelTables,
  serializeSchemaToInstdata,
} from './src/schema/gel_persistence.js';

const stripHashComments = (source: string): string => {
  let output = '';
  let inComment = false;
  for (const ch of source) {
    if (inComment) {
      if (ch === '\n') { inComment = false; output += ch; }
      continue;
    }
    if (ch === '#') { inComment = true; continue; }
    output += ch;
  }
  return output;
};

(async () => {
  const cwd = process.cwd();
  const schemaDir = path.join(cwd, 'tests/schemas');
  const schemaBody = stripHashComments(fs.readFileSync(path.join(schemaDir, 'issues.esdl'), 'utf8'));
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

  const setup = fs.readFileSync(path.join(schemaDir, 'issues_coalesce_setup.edgeql'), 'utf8');
  executeScript(db, snapshot, setup);

  const q = process.argv[2] || `SELECT Issue { time_estimate := Issue.time_estimate ?? -<int64>Issue.number } ORDER BY Issue.time_estimate;`;
  console.log('=== Query ===');
  console.log(q);
  try {
    const t = executeQueryWithTrace(db, snapshot, q);
    console.log('=== SQL ===');
    console.log((t.sql as any).sql || JSON.stringify(t.sql, null, 2));
    console.log('=== Result ===');
    console.log(JSON.stringify(t.result, null, 2));
  } catch (e: any) {
    console.log('ERROR:', e.message);
    console.log(e.stack?.split('\n').slice(0,8).join('\n'));
  }
})().catch((err) => { console.error(err); process.exit(1); });
