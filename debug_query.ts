import fs from 'node:fs';
import path from 'node:path';
import { openSQLite, materializeSchema } from './src/runtime/database.js';
// import { parseDeclarativeSchema } from './src/schema/declarative.js';
import { schemaSnapshotFromDeclarative } from './src/schema/uiSchema.js';
import { executeScript, executeQueryWithTrace, executeQuery } from './src/runtime/engine.js';
import { ensureGelSchemaTables, serializeSchemaToGelTables, serializeSchemaToInstdata } from './src/schema/gel_persistence.js';
import { parseDeclarativeSchema } from './src/schema/sdl_adapter.js';

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
  // const schemaPath = path.join(cwd, 'tests/schemas/dump01_default.esdl');
  // const setupPath = path.join(cwd, 'tests/schemas/dump01_setup.edgeql');

  // if (!fs.existsSync(schemaPath)) throw new Error(`Schema not found at ${schemaPath}`);

  // const schemaBody = stripHashComments(fs.readFileSync(schemaPath, 'utf8'));
  // const schemaSource = schemaBody.trimStart().startsWith('module ')
    // ? schemaBody
    // : 'module default {\n' + schemaBody + '\n}';

  const trueSchema = `module default {
        type User {
          required name: str;
        }

        type Organization {
          required name: str;
        }

        type Issue {
          required title: str;
          owner: User | Organization;
        }
      }`;

  const decl = parseDeclarativeSchema(trueSchema, {legacySyntaxCompat: true });
  //console.dir(decl.types.filter(x => x.name === "User")[0].members.filter(x => x.name === "deck")[0]["properties"])
  const snapshot = schemaSnapshotFromDeclarative(decl); //not using the new computed properties/links in SDL
  console.dir(snapshot.getType("default::User")?.links?.filter(x => x.name === "deck")[0].properties);
  const { db } = openSQLite(':memory:');

  materializeSchema(db, snapshot);
  ensureGelSchemaTables(db);
  serializeSchemaToGelTables(db, snapshot);
  serializeSchemaToInstdata(db, snapshot);

  // const rawSetup = stripHashComments(fs.readFileSync(setupPath, 'utf8'));
  // const setModuleMatch = rawSetup.match(/^\s*SET\s+MODULE\s+([A-Za-z_][\w:]*)\s*;/im);
  // const currentModule = setModuleMatch ? setModuleMatch[1] : 'default';
  // const setupNoSetModule = rawSetup.replace(/^\s*SET\s+MODULE\s+[^;]+;\s*$/gim, '');

  // const setupQueries = setupNoSetModule.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
  // for (const q of setupQueries) {
    // const stmt = /^\s*WITH\b/i.test(q) ? q : qualifyUnqualifiedTypes(q, currentModule);
    // executeScript(db, snapshot, stmt + ';');
  // }

  const query = 'SELECT User { name, deck_cost } ORDER BY .name;';
  executeQuery(db, snapshot, "insert default::User { name := 'Ada' };");
    executeQuery(db, snapshot, "insert default::Organization { name := 'Gel' };");
    executeQuery(db, snapshot, "insert default::Issue { title := 'user-owned', owner := (select default::User filter .name = 'Ada') };");
    executeQuery(db, snapshot, "insert default::Issue { title := 'org-owned', owner := (select default::Organization filter .name = 'Gel') };");

    const trace = executeQueryWithTrace(
      db,
      snapshot,
      "select default::Issue { title, owner: { name, type_name := .__type__.name } } order by .title;",
    );


  // const trace = executeQueryWithTrace(db, snapshot, query);
  const last = trace;
  const sqlText = last?.sql?.sql ?? '';
  const loweringMode = last?.sql?.loweringMode ?? '<none>';
  const rows = last?.result && last.result.kind === 'select' ? last.result.rows : [];

  console.log('--- Query ---');
  console.log(query);
  console.log('--- Lowering mode ---');
  console.log(loweringMode);
  console.log('--- Generated SQL ---');
  console.log(sqlText);
  console.log('--- AST ---');
  console.log(JSON.stringify(trace, null, 2))

})().catch((err) => {
  console.error(err);
  process.exit(1);
});
