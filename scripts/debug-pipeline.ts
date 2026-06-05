import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import type { RuntimeTarget } from "../src/runtime/target.js";
import { buildPipelineDebugReport, type DebugToken, type PipelineDebugOutput } from "./debug-pipeline-core.js";

interface CliOptions {
  query?: string;
  queryFile?: string;
  schemaFile?: string;
  setupFile?: string;
  json: boolean;
  color: boolean;
  target: RuntimeTarget;
}

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const main = (): void => {
  const options = parseArgs(process.argv.slice(2));
  const query = readQuery(options);
  const output = buildPipelineDebugReport({
    query,
    schemaInput: options.schemaFile,
    setupInput: options.setupFile,
    target: options.target,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (!output.ok) process.exitCode = 1;
    return;
  }

  printHumanOutput(output, options.color);
  if (!output.ok) process.exitCode = 1;
};

const parseArgs = (args: string[]): CliOptions => {
  const options: CliOptions = {
    json: false,
    color: process.stdout.isTTY && process.env.NO_COLOR === undefined,
    target: "sqlite",
  };
  const queryParts: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--query" || arg === "-q") {
      options.query = readRequiredValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--file" || arg === "-f") {
      options.queryFile = readRequiredValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--schema" || arg === "-s") {
      options.schemaFile = readRequiredValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--setup") {
      options.setupFile = readRequiredValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--target") {
      const value = readRequiredValue(args, i, arg);
      if (!isRuntimeTarget(value)) {
        fail(`Unsupported target '${value}'. Expected 'sqlite' or 'd1'.`);
      }
      options.target = value;
      i += 1;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--no-color") {
      options.color = false;
      continue;
    }
    if (arg.startsWith("-")) {
      fail(`Unknown option '${arg}'.`);
    }
    queryParts.push(arg);
  }

  if (queryParts.length > 0 && options.query === undefined) {
    options.query = queryParts.join(" ");
  }

  if (options.query !== undefined && options.queryFile !== undefined) {
    fail("Use either --query or --file, not both.");
  }

  return options;
};

const readRequiredValue = (args: string[], index: number, flag: string): string => {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) {
    fail(`Missing value for ${flag}.`);
  }
  return value;
};

const isRuntimeTarget = (value: string): value is RuntimeTarget => value === "sqlite" || value === "d1";

const readQuery = (options: CliOptions): string => {
  if (options.query !== undefined) {
    return options.query;
  }
  if (options.queryFile !== undefined) {
    return readFileSync(options.queryFile, "utf8");
  }
  if (!process.stdin.isTTY) {
    return readFileSync(0, "utf8");
  }
  printUsage();
  process.exit(1);
};

const printHumanOutput = (output: PipelineDebugOutput, color: boolean): void => {
  section("Query", color);
  process.stdout.write(`${output.query.trim()}\n`);

  section("Schema", color);
  if (output.schema) {
    process.stdout.write(`${output.schema.path} (${output.schema.typeCount} types)\n`);
    if (output.schema.loadedFiles?.length) {
      process.stdout.write(`${formatJson({ loadedFiles: output.schema.loadedFiles }, color)}\n`);
    }
  } else {
    process.stdout.write("<empty schema>\n");
  }

  section("Setup", color);
  if (output.setup) {
    process.stdout.write(`${output.setup.path} (${output.setup.statementCount} parsed statements)\n`);
  } else {
    process.stdout.write("<no setup>\n");
  }

  section("Stages", color);
  process.stdout.write(`${formatJson(output.stages, color)}\n`);

  if (output.diagnostics.length > 0) {
    section("Diagnostics", color);
    process.stdout.write(`${formatJson(output.diagnostics, color)}\n`);
  }

  if (output.tokens) {
    section("Tokens", color);
    printTokens(output.tokens, color);
  }

  if (output.ast) {
    section("AST", color);
    process.stdout.write(`${formatJson(output.ast, color)}\n`);
  }

  if (output.expandedAst) {
    section("Expanded AST", color);
    process.stdout.write(`${formatJson(output.expandedAst, color)}\n`);
  }

  if (output.gelIr) {
    section("Gel IR", color);
    process.stdout.write(`${formatJson(output.gelIr, color)}\n`);
  }

  if (output.sql) {
    section("SQL", color);
    process.stdout.write(`${formatSql(output.sql.sql, color)}\n`);
    process.stdout.write(`${formatJson({ params: output.sql.params, loweringMode: output.sql.loweringMode }, color)}\n`);
  }
};

const printTokens = (tokens: DebugToken[], color: boolean): void => {
  const rows = tokens.map((token) => ({
    pos: `${token.line}:${token.column}`,
    kind: token.kind,
    lexeme: JSON.stringify(token.lexeme),
  }));
  const posWidth = Math.max("pos".length, ...rows.map((row) => row.pos.length));
  const kindWidth = Math.max("kind".length, ...rows.map((row) => row.kind.length));
  process.stdout.write(`${pad("pos", posWidth)}  ${pad("kind", kindWidth)}  lexeme\n`);
  for (const row of rows) {
    const kind = paint(pad(row.kind, kindWidth), tokenKindColor(row.kind), color);
    process.stdout.write(`${paint(pad(row.pos, posWidth), colors.gray, color)}  ${kind}  ${row.lexeme}\n`);
  }
};

const formatJson = (value: unknown, color: boolean): string => {
  const json = JSON.stringify(value, null, 2);
  if (!color) {
    return json;
  }

  return json.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi,
    (match, stringValue: string | undefined, colon: string | undefined) => {
      if (stringValue !== undefined) {
        if (colon !== undefined) {
          return `${colors.cyan}${stringValue}${colors.reset}${colon}`;
        }
        return `${colors.green}${stringValue}${colors.reset}`;
      }
      if (match === "true" || match === "false") {
        return `${colors.magenta}${match}${colors.reset}`;
      }
      if (match === "null") {
        return `${colors.gray}${match}${colors.reset}`;
      }
      return `${colors.yellow}${match}${colors.reset}`;
    },
  );
};

const formatSql = (sql: string, color: boolean): string => {
  if (!color) {
    return sql;
  }
  return sql.replace(
    /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|VALUES|RETURNING|WITH|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AS|AND|OR|NOT|NULL|ORDER|BY|LIMIT|OFFSET|GROUP|HAVING|UNION|ALL|EXISTS|CASE|WHEN|THEN|ELSE|END)\b/gi,
    (keyword) => paint(keyword, colors.blue, color),
  );
};

const tokenKindColor = (kind: string): string => {
  if (kind.startsWith("kw_")) return colors.blue;
  if (kind === "identifier" || kind === "backtick_name") return colors.cyan;
  if (kind === "string" || kind === "bytes_string") return colors.green;
  if (kind === "number") return colors.yellow;
  if (kind === "eof") return colors.gray;
  return colors.magenta;
};

const section = (title: string, color: boolean): void => {
  process.stdout.write(`\n${paint(title, `${colors.bold}${colors.blue}`, color)}\n`);
};

const pad = (value: string, width: number): string => value.padEnd(width, " ");

const paint = (value: string, colorCode: string, enabled: boolean): string => (
  enabled ? `${colorCode}${value}${colors.reset}` : value
);

const printUsage = (): void => {
  const script = basename(fileURLToPath(import.meta.url));
  process.stderr.write(`Usage:\n`);
  process.stderr.write(`  npm run debug:pipeline -- --schema tests/schemas/cards.esdl --query "SELECT User { name }"\n`);
  process.stderr.write(`  tsx scripts/${script} --json --file query.edgeql\n\n`);
  process.stderr.write(`Options:\n`);
  process.stderr.write(`  -q, --query <edgeql>     Query text to inspect\n`);
  process.stderr.write(`  -f, --file <path>        Read query text from a file\n`);
  process.stderr.write(`  -s, --schema <path|name> Load declarative schema path or tests/schemas fixture\n`);
  process.stderr.write(`      --setup <path|name>  Parse-check setup path or tests/schemas fixture\n`);
  process.stderr.write(`      --target <target>    sqlite or d1 (default: sqlite)\n`);
  process.stderr.write(`      --json               Print one pretty JSON object\n`);
  process.stderr.write(`      --no-color           Disable ANSI color\n`);
};

const fail = (message: string): never => {
  process.stderr.write(`${message}\n\n`);
  printUsage();
  process.exit(1);
};

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${colors.red}debug-pipeline failed:${colors.reset} ${message}\n`);
  process.exit(1);
}
