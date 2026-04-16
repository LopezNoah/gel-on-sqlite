import fs from 'node:fs';
import path from 'node:path';
import { openSQLite, materializeSchema } from './src/runtime/database.js';
import { parseDeclarativeSchema } from './src/schema/declarative.js';
import { schemaSnapshotFromDeclarative } from './src/schema/uiSchema.js';
import { executeScript, executeQueryWithTrace } from './src/runtime/engine.js';
import { ensureGelSchemaTables, serializeSchemaToGelTables, serializeSchemaToInstdata } from './src/schema/gel_persistence.js';

const stripHashComments = (source: string): string => source.replace(/^\s*#.*$/gm, '');

const qualifyUnqualifiedTypes = (source: string, moduleName: string): string =>
  source
    .replace(/\b(INSERT|UPDATE|DELETE)\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)?)\b/gi, (m, kw, typeName) => {
      if (typeName.includes('::')) return m;
      return kw + ' ' + moduleName + '::' + typeName;
    })
    .replace(/\bSELECT\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)?)\s*(?=[\{<\s]|$)/gi, (m, typeName) => {
      if (
        typeName.includes('::')
        || ['MODULE','DETACHED','DISTINCT','count','array_agg','array_join','str_lower','str_upper','sum','len'].includes(typeName)
      ) return m;
      return 'SELECT ' + moduleName + '::' + typeName;
    });

(async () => {
  const cwd = process.cwd();
  const schemaPath = path.join(cwd, 'tests/schemas/cards.esdl');
  const setupPath = path.join(cwd, 'tests/schemas/cards_setup.edgeql');

  if (!fs.existsSync(schemaPath)) throw new Error(`Schema not found at ${schemaPath}`);

  const schemaBody = stripHashComments(fs.readFileSync(schemaPath, 'utf8'));
  const schemaSource = schemaBody.trimStart().startsWith('module ')
    ? schemaBody
    : 'module default {\n' + schemaBody + '\n}';

  const decl = parseDeclarativeSchema(schemaSource);
  const snapshot = schemaSnapshotFromDeclarative(decl);
  const { db } = openSQLite(':memory:');

  materializeSchema(db, snapshot);
  ensureGelSchemaTables(db);
  serializeSchemaToGelTables(db, snapshot);
  serializeSchemaToInstdata(db, snapshot);

  const rawSetup = stripHashComments(fs.readFileSync(setupPath, 'utf8'));
  const setModuleMatch = rawSetup.match(/^\s*SET\s+MODULE\s+([A-Za-z_][\w:]*)\s*;/im);
  const currentModule = setModuleMatch ? setModuleMatch[1] : 'default';
  const setupNoSetModule = rawSetup.replace(/^\s*SET\s+MODULE\s+[^;]+;\s*$/gim, '');

  const setupQueries = setupNoSetModule.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
  for (const q of setupQueries) {
    const stmt = /^\s*WITH\b/i.test(q) ? q : qualifyUnqualifiedTypes(q, currentModule);
    executeScript(db, snapshot, stmt + ';');
  }

  const query1 = 'SELECT User { name, deck_cost } ORDER BY .name;';
  const query = `SELECT User {
                    name,
                    deck_cost
                }
                ORDER BY User.name;`;
  const trace = executeQueryWithTrace(db, snapshot, query);
  const last = trace;
  const sqlText = last?.sql?.sql ?? '';
  const loweringMode = last?.sql?.loweringMode ?? '<none>';
  const rows = last?.result && last.result.kind === 'select' ? last.result.rows : [];
  const rowsWithDeckCount = rows.map((row) => {
    const item = row as { name?: unknown; deck_cost?: unknown };
    return {
      name: item.name,
      deck_cost: item.deck_cost,
      deck_count: item.deck_cost,
    };
  });

  const sqlAggregateRows = db
    .prepare(
      `
      SELECT
        owner.name AS name,
        COALESCE(SUM(c.cost), 0) AS deck_cost_sql
      FROM (
        SELECT id, name FROM default__user
        UNION ALL
        SELECT id, name FROM default__bot
      ) owner
      LEFT JOIN default__user__deck d ON d.source = owner.id
      LEFT JOIN default__card c ON c.id = d.target
      GROUP BY owner.id, owner.name
      ORDER BY owner.name ASC
      `,
    )
    .all();

  console.log('--- Query ---');
  console.log(query);
  console.log('--- Lowering mode ---');
  console.log(loweringMode);
  console.log('--- Generated SQL ---');
  console.log(sqlText);
  console.log('--- Uses SQL SUM(...) ? ---');
  console.log(/\bsum\s*\(/i.test(sqlText));
  console.log('--- Query result rows ---');
  console.dir(rows, { depth: null });
  console.log('--- Query rows with deck_count alias ---');
  console.dir(rowsWithDeckCount, { depth: null });
  console.log('--- Direct SQL aggregate check (COALESCE(SUM(c.cost), 0)) ---');
  console.dir(sqlAggregateRows, { depth: null });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
