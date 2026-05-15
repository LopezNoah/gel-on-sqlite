import fs from 'node:fs';
import { openSQLite, materializeSchema } from './src/runtime/database.js';
import { schemaSnapshotFromDeclarative } from './src/schema/uiSchema.js';
import { executeScript, executeQueryWithTrace, executeQuery } from './src/runtime/engine.js';
import { ensureGelSchemaTables, serializeSchemaToGelTables, serializeSchemaToInstdata } from './src/schema/gel_persistence.js';
import { parseDeclarativeSchema } from './src/schema/sdl_adapter.js';
import { parseEdgeQL } from './src/edgeql/parser.js';
import { getCompilerService } from './src/compiler/service.js';

const stripHashComments = (source: string): string => source.replace(/^\s*#.*$/gm, '');

(async () => {
  const schemaPath = 'tests/schemas/cards.esdl';
  const setupPath = 'tests/schemas/cards_setup.edgeql';

  const schemaSource = `module default {\n${stripHashComments(fs.readFileSync(schemaPath, 'utf8'))}\n}`;
  const decl = parseDeclarativeSchema(schemaSource, { legacySyntaxCompat: true });
  const snapshot = schemaSnapshotFromDeclarative(decl);
  const { db } = openSQLite(':memory:');

  materializeSchema(db, snapshot);
  ensureGelSchemaTables(db);
  serializeSchemaToGelTables(db, snapshot);
  serializeSchemaToInstdata(db, snapshot);

  const setupSource = stripHashComments(fs.readFileSync(setupPath, 'utf8'));
  executeScript(db, snapshot, setupSource);

  const query = process.argv[2] ?? '';

  if (process.argv.includes('--ast')) {
    try {
      const ast = parseEdgeQL(query);
      console.log('--- AST ---');
      console.log(JSON.stringify(ast, null, 2));
    } catch (e) {
      console.error('Parse error:', (e as Error).message);
    }
  }

  if (process.argv.includes('--ir')) {
    try {
      const ast = parseEdgeQL(query);
      const compiled = getCompilerService().compile(snapshot, ast, {});
      console.log('--- IR ---');
      console.log(JSON.stringify(compiled.ir, null, 2));
    } catch (e) {
      console.error('Compile error:', (e as Error).message);
    }
  }
  if (process.argv.includes('--gelir')) {
    try {
      const ast = parseEdgeQL(query);
      const compiled = getCompilerService().compile(snapshot, ast, {});
      console.log('--- gelIR ---');
      console.log(JSON.stringify(compiled.gelIr ?? compiled.ir, null, 2));
      console.log('--- SQL ---');
      console.log(compiled.sql.sql);
    } catch (e) {
      console.error('Compile error:', (e as Error).message);
    }
  }

  try {
    const r = executeQuery(db, snapshot, query);
    console.log('--- executeQuery Rows (count:', (r as any).rows?.length, ') ---');
    console.log(JSON.stringify((r as any).rows, null, 2));
  } catch (e) {
    console.error('executeQuery Error:', (e as Error).message);
  }
  try {
    const trace = executeQueryWithTrace(db, snapshot, query);
    console.log('--- Direct SQL ---');
    console.log(trace?.sql?.sql ?? '');
    const rows = trace?.result && trace.result.kind === 'select' ? trace.result.rows : null;
    if (rows) {
      console.log('--- Direct Rows ---');
      console.log(JSON.stringify(rows, null, 2));
    }
  } catch (e) {
    console.error('Trace Error:', (e as Error).message);
  }
})();
