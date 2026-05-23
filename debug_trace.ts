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
      if (typeName.includes('::') || ['MODULE','DETACHED','DISTINCT','count','array_agg','array_join','str_lower','str_upper','sum','len'].includes(typeName)) return m;
      return 'SELECT ' + moduleName + '::' + typeName;
    });

(async () => {
  const cwd = process.cwd();
  const schemaPath = path.join(cwd, 'tests/schemas/cards.esdl');

  const schemaBody = stripHashComments(fs.readFileSync(schemaPath, 'utf8'));
  const schemaSource = schemaBody.trimStart().startsWith('module ') ? schemaBody : 'module default {\n' + schemaBody + '\n}';

  const decl = parseDeclarativeSchema(schemaSource);
  const snapshot = schemaSnapshotFromDeclarative(decl);
  const { db } = openSQLite(':memory:');

  materializeSchema(db, snapshot);
  ensureGelSchemaTables(db);
  serializeSchemaToGelTables(db, snapshot);
  serializeSchemaToInstdata(db, snapshot);

  const rawSetup = stripHashComments(fs.readFileSync(path.join(cwd, 'tests/schemas/cards_setup.edgeql'), 'utf8'));
  const setModuleMatch = rawSetup.match(/^\s*SET\s+MODULE\s+([A-Za-z_][\w:]*)\s*;/im);
  const currentModule = setModuleMatch ? setModuleMatch[1] : 'default';
  const setupNoSetModule = rawSetup.replace(/^\s*SET\s+MODULE\s+[^;]+;\s*$/gim, '');
  const setupQueries = setupNoSetModule.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
  for (const q of setupQueries) {
    const stmt = /^\s*WITH\b/i.test(q) ? q : qualifyUnqualifiedTypes(q, currentModule);
    executeScript(db, snapshot, stmt + ';');
  }

  // Check all tables
  console.log('=== ALL TABLES ===');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r: any) => r.name);
  console.log(tables.join('\n'));

  // Check all avatar link tables
  console.log('\n=== ALL AVATAR LINK DATA ===');
  for (const table of tables) {
    if (table.includes('avatar')) {
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      console.log(`\n--- ${table} (${rows.length} rows) ---`);
      console.dir(rows, { depth: null });
    }
  }

  // Check SpecialCard table
  console.log('\n=== SpecialCard table ===');
  try { console.dir(db.prepare('SELECT * FROM default__specialcard').all(), { depth: null }); } catch { console.log('none'); }

  // Check Card table
  console.log('\n=== Card table (all fields) ===');
  console.dir(db.prepare('SELECT * FROM default__card ORDER BY name').all(), { depth: null });

  // Direct query: what cards have backlinks via avatar?
  console.log('\n=== Direct backlink check: cards that have avatars ===');

  // Check what users/bots exist
  console.log('\n=== Users ===');
  console.dir(db.prepare('SELECT id, name FROM default__user').all(), { depth: null });
  console.log('\n=== Bots ===');
  console.dir(db.prepare('SELECT id, name FROM default__bot').all(), { depth: null });

  // Check the resolveBacklinks issue
  // For Djinn card, find who has avatar pointing to it
  const djinnRow = db.prepare("SELECT id, name FROM default__specialcard WHERE name = 'Djinn'").all();
  console.log('\n=== Djinn row ===');
  console.dir(djinnRow, { depth: null });

  if (djinnRow.length > 0) {
    const djinnId = (djinnRow[0] as any).id;
    console.log(`Djinn id: ${djinnId}`);

    // Find who has avatar pointing to Djinn
    const avatarToDjinn = db.prepare("SELECT source, target, text FROM default__user__avatar WHERE target = ?").all(djinnId);
    console.log('\n=== Avatar rows pointing to Djinn ===');
    console.dir(avatarToDjinn, { depth: null });

    // Check if the source is actual user or bot
    if (avatarToDjinn.length > 0) {
      const sourceId = (avatarToDjinn[0] as any).source;
      const user = db.prepare("SELECT id, name FROM default__user WHERE id = ?").all(sourceId);
      console.log(`\nSource user:`, user);
      const bot = db.prepare("SELECT id, name FROM default__bot WHERE id = ?").all(sourceId);
      console.log(`Source bot:`, bot);
    }
  }

  // Check link ownership
  console.log('\n=== Bot type links ===');
  const botType = snapshot.getType('default::Bot');
  if (botType) {
    console.log('Bot extends:', botType.extends);
    console.log('Bot links (direct):', botType.links?.map((l: any) => `${l.name} (target: ${l.targetType})`));
    console.log('Bot links count:', botType.links?.length ?? 0);
  }
  console.log('\n=== User type links ===');
  const userType = snapshot.getType('default::User');
  if (userType) {
    console.log('User links (direct):', userType.links?.map((l: any) => `${l.name} (target: ${l.targetType})`));
  }

  // Check what resolveBacklinkSources returns
  const query = `WITH C := Card { ava_owners := .<avatar } SELECT C { name, ava_owners: { typename := ( WITH name := C.ava_owners.__type__.name SELECT name ) } } FILTER EXISTS .ava_owners ORDER BY .name`;

  console.log('\n\n=== QUERY TRACE (full) ===');
  const trace = executeQueryWithTrace(db, snapshot, query);
  
  console.log('Top-level SQL:', trace.sql?.sql);
  console.log('Lowering mode:', trace.sql?.loweringMode);
  console.log('\n=== SQL Trail ===');
  if (trace.sqlTrail) {
    for (let i = 0; i < trace.sqlTrail.length; i++) {
      const entry = trace.sqlTrail[i];
      console.log(`\n[${i}] ${entry.loweringMode}: ${entry.sql}`);
      if (entry.params?.length) console.log('   params:', entry.params);
    }
  }
  console.log('\n=== RESULT ===');
  console.dir(trace.result, { depth: null });

})().catch((err) => { console.error(err); process.exit(1); });
