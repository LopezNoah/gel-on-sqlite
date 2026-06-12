import express from "express";

import type { RuntimeTarget } from "../src/runtime/target.js";
import { buildPipelineDebugReport } from "./debug-pipeline-core.js";

interface CliOptions {
  port: number;
  schemaFile?: string;
  setupFile?: string;
  query: string;
  target: RuntimeTarget;
}

interface DebugRequestBody {
  query?: unknown;
  schemaFile?: unknown;
  setupFile?: unknown;
  target?: unknown;
}

const main = (): void => {
  const options = parseArgs(process.argv.slice(2));
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/", (_req, res) => {
    res.type("html").send(renderHtml(options));
  });

  app.post("/api/debug", (req, res) => {
    const body = req.body as DebugRequestBody;
    const query = typeof body.query === "string" ? body.query : "";
    const schemaFile = typeof body.schemaFile === "string" && body.schemaFile.trim() !== ""
      ? body.schemaFile.trim()
      : options.schemaFile;
    const setupFile = typeof body.setupFile === "string" && body.setupFile.trim() !== ""
      ? body.setupFile.trim()
      : options.setupFile;
    const target = isRuntimeTarget(body.target) ? body.target : options.target;

    if (query.trim() === "") {
      res.status(400).json({ ok: false, error: "Query is required." });
      return;
    }

    const output = buildPipelineDebugReport({ query, schemaInput: schemaFile, setupInput: setupFile, target });
    res.json({ ok: output.ok, data: output });
  });

  app.listen(options.port, () => {
    process.stdout.write(`sqlite-ts pipeline debug UI: http://127.0.0.1:${options.port}\n`);
  });
};

const parseArgs = (args: string[]): CliOptions => {
  const options: CliOptions = {
    port: 4179,
    query: "SELECT User { name }",
    target: "sqlite",
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--port" || arg === "-p") {
      const value = Number(readRequiredValue(args, i, arg));
      if (!Number.isInteger(value) || value <= 0) {
        fail(`Invalid port '${args[i + 1]}'.`);
      }
      options.port = value;
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
    if (arg === "--query" || arg === "-q") {
      options.query = readRequiredValue(args, i, arg);
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
    fail(`Unknown option '${arg}'.`);
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

const isRuntimeTarget = (value: unknown): value is RuntimeTarget => value === "sqlite" || value === "d1";

const renderHtml = (options: CliOptions): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>sqlite-ts Pipeline Debugger</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101216;
      --panel: #171b22;
      --panel-2: #202633;
      --border: #31394a;
      --text: #edf2ff;
      --muted: #9aa6bd;
      --accent: #7dd3fc;
      --green: #86efac;
      --yellow: #fde68a;
      --pink: #f0abfc;
      --red: #fca5a5;
      --blue: #93c5fd;
      --orange: #fdba74;
      --purple: #c4b5fd;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: radial-gradient(circle at top left, #1f2a44, var(--bg) 38rem); color: var(--text); }
    main { width: min(1440px, calc(100vw - 32px)); margin: 0 auto; padding: 28px 0 48px; }
    header { display: flex; justify-content: space-between; gap: 20px; align-items: end; margin-bottom: 18px; }
    h1 { margin: 0; font-size: clamp(28px, 4vw, 54px); letter-spacing: -0.05em; }
    .subhead { margin: 6px 0 0; color: var(--muted); max-width: 760px; line-height: 1.5; }
    .badge { border: 1px solid var(--border); color: var(--accent); border-radius: 999px; padding: 8px 12px; background: rgb(125 211 252 / 0.08); white-space: nowrap; }
    .workspace { display: grid; grid-template-columns: minmax(320px, 420px) minmax(0, 1fr); gap: 16px; align-items: start; }
    .panel { background: rgb(23 27 34 / 0.92); border: 1px solid var(--border); border-radius: 20px; box-shadow: 0 24px 80px rgb(0 0 0 / 0.22); overflow: hidden; }
    .panel-inner { padding: 16px; }
    label { display: block; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }
    textarea, input, select { width: 100%; border: 1px solid var(--border); background: #0c0f14; color: var(--text); border-radius: 12px; padding: 12px; font: 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; outline: none; }
    textarea { min-height: 210px; resize: vertical; line-height: 1.5; }
    textarea:focus, input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgb(125 211 252 / 0.12); }
    .field { margin-bottom: 14px; }
    .row { display: grid; grid-template-columns: 1fr 130px; gap: 10px; }
    button { border: 0; background: linear-gradient(135deg, #38bdf8, #818cf8); color: #06111f; border-radius: 12px; padding: 12px 14px; font-weight: 800; cursor: pointer; width: 100%; }
    button:disabled { opacity: 0.55; cursor: wait; }
    .hint { color: var(--muted); font-size: 13px; line-height: 1.45; }
    .tabs { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px; border-bottom: 1px solid var(--border); background: rgb(32 38 51 / 0.55); position: sticky; top: 0; z-index: 1; }
    .tab { width: auto; color: var(--muted); background: transparent; border: 1px solid var(--border); padding: 8px 10px; font-weight: 700; }
    .tab.active { color: #06111f; background: var(--accent); border-color: var(--accent); }
    .output { min-height: 620px; max-height: calc(100vh - 170px); overflow: auto; }
    .stage { display: none; padding: 16px; }
    .stage.active { display: block; }
    .error { color: #fecaca; background: rgb(248 113 113 / 0.12); border: 1px solid rgb(248 113 113 / 0.35); border-radius: 14px; padding: 14px; white-space: pre-wrap; }
    .diagnostics { display: grid; gap: 10px; margin-bottom: 14px; }
    .diagnostic { border: 1px solid rgb(248 113 113 / 0.38); border-left: 5px solid var(--red); border-radius: 15px; background: rgb(248 113 113 / 0.1); padding: 12px; }
    .diagnostic h3 { margin: 0 0 6px; font-size: 15px; color: #fecaca; }
    .diagnostic p { margin: 0; color: #ffd7d7; line-height: 1.45; }
    .diagnostic .diag-meta { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
    .diag-pill { display: inline-flex; border-radius: 999px; padding: 2px 8px; background: rgb(0 0 0 / 0.22); color: var(--yellow); font-size: 11px; font-weight: 800; }
    .timeline { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
    .stage-pill { border: 1px solid var(--border); border-radius: 999px; padding: 4px 9px; color: var(--muted); font-size: 11px; font-weight: 800; }
    .stage-pill.ok { color: var(--green); border-color: rgb(134 239 172 / 0.35); background: rgb(134 239 172 / 0.08); }
    .stage-pill.failed { color: #fecaca; border-color: rgb(248 113 113 / 0.45); background: rgb(248 113 113 / 0.1); }
    .stage-pill.skipped { color: var(--muted); background: rgb(255 255 255 / 0.03); }
    .sql { background: #0c0f14; border: 1px solid var(--border); border-radius: 14px; padding: 14px; overflow: auto; white-space: pre-wrap; font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .json-tree { font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    details { margin-left: 14px; }
    details.root { margin-left: 0; }
    summary { cursor: pointer; color: var(--muted); padding: 2px 0; }
    .key { color: var(--accent); }
    .string { color: var(--green); }
    .number { color: var(--yellow); }
    .boolean { color: var(--pink); }
    .null { color: var(--muted); }
    .kind { color: var(--blue); font-weight: 800; }
    table { width: 100%; border-collapse: collapse; font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    th, td { text-align: left; border-bottom: 1px solid var(--border); padding: 8px; vertical-align: top; }
    th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
    .pill { display: inline-flex; border-radius: 999px; padding: 2px 8px; background: rgb(125 211 252 / 0.12); color: var(--accent); }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; color: var(--muted); }
    .toolbar { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 14px; }
    .toolbar select { width: auto; min-width: 180px; padding: 8px 10px; }
    .toolbar-title { font-size: 13px; color: var(--muted); }
    .graph-shell { position: relative; min-width: 920px; border: 1px solid var(--border); border-radius: 18px; background: linear-gradient(135deg, rgb(125 211 252 / 0.06), rgb(196 181 253 / 0.05)); overflow: auto; padding: 22px; }
    .graph-lines { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
    .graph-columns { position: relative; display: grid; grid-auto-flow: column; grid-auto-columns: 270px; gap: 30px; align-items: start; z-index: 1; }
    .graph-column { display: grid; gap: 14px; }
    .graph-depth { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; margin: 0 0 2px; }
    .graph-node { position: relative; border: 1px solid var(--border); border-top: 4px solid var(--accent); border-radius: 16px; background: rgb(12 15 20 / 0.94); padding: 12px; box-shadow: 0 14px 38px rgb(0 0 0 / 0.28); }
    .graph-node h3 { margin: 0 0 8px; font-size: 15px; line-height: 1.25; word-break: break-word; }
    .graph-node .node-kind { display: inline-flex; max-width: 100%; color: #07111d; background: var(--accent); border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 900; margin-bottom: 8px; }
    .graph-node .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
    .graph-chip { color: var(--text); border: 1px solid var(--border); background: rgb(255 255 255 / 0.04); border-radius: 999px; padding: 2px 7px; font-size: 11px; }
    .node-fields { display: grid; gap: 4px; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .field-row { display: grid; grid-template-columns: minmax(64px, 0.42fr) minmax(0, 1fr); gap: 6px; color: var(--muted); }
    .field-row strong { color: var(--accent); font-weight: 700; overflow: hidden; text-overflow: ellipsis; }
    .edge-label { position: absolute; z-index: 2; transform: translate(-50%, -50%); color: var(--muted); background: #0c0f14; border: 1px solid var(--border); border-radius: 999px; padding: 2px 7px; font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; pointer-events: none; }
    .sql-explain { display: grid; gap: 14px; }
    .explain-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .explain-card { border: 1px solid var(--border); border-radius: 16px; background: rgb(12 15 20 / 0.78); padding: 14px; }
    .explain-card h3 { margin: 0 0 8px; font-size: 15px; }
    .explain-card p { margin: 0; color: var(--muted); line-height: 1.45; }
    .metric { display: block; color: var(--accent); font-size: 28px; font-weight: 900; letter-spacing: -0.04em; margin-bottom: 3px; }
    .branch-flow { display: grid; gap: 10px; }
    .branch-card { border: 1px solid var(--border); border-left: 5px solid var(--accent); border-radius: 15px; background: rgb(12 15 20 / 0.9); padding: 12px; }
    .branch-card h4 { margin: 0 0 8px; font-size: 14px; }
    .branch-card code, .projection-row code { color: var(--green); }
    .union-rail { display: inline-flex; width: max-content; color: #07111d; background: var(--orange); border-radius: 999px; padding: 3px 10px; font-size: 11px; font-weight: 900; margin-left: 14px; }
    .projection-list { display: grid; gap: 8px; }
    .projection-row { display: grid; grid-template-columns: minmax(90px, 0.3fr) minmax(0, 1fr); gap: 10px; color: var(--muted); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .sql-highlight { background: #0c0f14; border: 1px solid var(--border); border-radius: 14px; padding: 14px; overflow: auto; white-space: pre-wrap; font: 13px/1.7 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .sql-keyword { color: var(--blue); font-weight: 900; }
    .sql-string { color: var(--green); }
    .sql-ident { color: var(--pink); }
    .sql-union { color: #07111d; background: var(--orange); border-radius: 6px; padding: 1px 5px; font-weight: 900; }
    @media (max-width: 900px) {
      header { display: block; }
      .badge { display: inline-block; margin-top: 12px; }
      .workspace { grid-template-columns: 1fr; }
      .output { max-height: none; }
      .graph-shell { min-width: 760px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Pipeline Debugger</h1>
        <p class="subhead">Dev-only browser view for tokenizer -> parser -> AST -> expanded AST -> IR -> Gel IR -> SQL. Nothing here is mounted in the shipped sqlite-ts HTTP server.</p>
      </div>
      <div class="badge">script-only debug UI</div>
    </header>
    <div class="workspace">
      <section class="panel">
        <div class="panel-inner">
          <div class="field">
            <label for="query">EdgeQL</label>
            <textarea id="query" spellcheck="false">${escapeHtml(options.query)}</textarea>
          </div>
          <div class="field">
            <label for="schema">Schema path or fixture</label>
            <input id="schema" value="${escapeHtml(options.schemaFile ?? "cards")}" spellcheck="false" />
          </div>
          <div class="field">
            <label for="setup">Setup path or fixture</label>
            <input id="setup" value="${escapeHtml(options.setupFile ?? "")}" placeholder="optional, e.g. dump01_setup" spellcheck="false" />
          </div>
          <div class="row field">
            <div>
              <label for="target">Target</label>
              <select id="target">
                <option value="sqlite"${options.target === "sqlite" ? " selected" : ""}>sqlite</option>
                <option value="d1"${options.target === "d1" ? " selected" : ""}>d1</option>
              </select>
            </div>
            <div>
              <label>&nbsp;</label>
              <button id="run">Inspect</button>
            </div>
          </div>
          <p class="hint">Use schema fixture names like <code>dump01_test</code> to load companion files such as <code>dump01_default.esdl</code>. Setup fixtures are parse-checked, not executed.</p>
        </div>
      </section>
      <section class="panel">
        <nav class="tabs" id="tabs"></nav>
        <div class="output" id="output"><div class="stage active"><p class="hint">Run a query to inspect the pipeline.</p></div></div>
      </section>
    </div>
  </main>
  <script>
    const stages = ["graph", "sql", "tokens", "ast", "expandedAst", "ir", "gelIr", "raw"];
    const labels = { graph: "Object Graph", sql: "SQL Explain", tokens: "Tokens", ast: "AST JSON", expandedAst: "Expanded AST", ir: "IR JSON", gelIr: "Gel IR", raw: "Raw JSON" };
    const tabs = document.getElementById("tabs");
    const output = document.getElementById("output");
    const runButton = document.getElementById("run");
    let activeStage = "graph";
    let graphSource = "ir";
    let lastData = null;

    function setBusy(busy) {
      runButton.disabled = busy;
      runButton.textContent = busy ? "Inspecting..." : "Inspect";
    }

    function renderTabs() {
      tabs.innerHTML = "";
      for (const stage of stages) {
        const button = document.createElement("button");
        button.className = "tab" + (stage === activeStage ? " active" : "");
        button.textContent = labels[stage];
        button.addEventListener("click", () => {
          activeStage = stage;
          renderTabs();
          renderOutput();
        });
        tabs.appendChild(button);
      }
    }

    async function run() {
      setBusy(true);
      try {
        const response = await fetch("/api/debug", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: document.getElementById("query").value,
            schemaFile: document.getElementById("schema").value,
            setupFile: document.getElementById("setup").value,
            target: document.getElementById("target").value,
          }),
        });
        const payload = await response.json();
        lastData = payload.data || null;
        renderOutput();
      } catch (err) {
        lastData = null;
        renderError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    }

    function renderError(message) {
      output.innerHTML = "";
      const div = document.createElement("div");
      div.className = "stage active";
      const error = document.createElement("div");
      error.className = "error";
      error.textContent = message;
      div.appendChild(error);
      output.appendChild(div);
    }

    function renderOutput() {
      output.innerHTML = "";
      const stage = document.createElement("div");
      stage.className = "stage active";
      if (!lastData) {
        stage.innerHTML = '<p class="hint">Run a query to inspect the pipeline.</p>';
        output.appendChild(stage);
        return;
      }
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.innerHTML = '<span class="pill">' + escapeText(lastData.ok ? "pipeline ok" : "pipeline failed") + '</span><span class="pill">' + escapeText(lastData.schema ? lastData.schema.path : "empty schema") + '</span><span class="pill">' + escapeText(lastData.setup ? lastData.setup.path : "no setup") + '</span><span class="pill">Gel IR SQL</span>';
      stage.appendChild(meta);
      stage.appendChild(renderStageTimeline(lastData.stages || []));
      if (lastData.diagnostics && lastData.diagnostics.length > 0) {
        stage.appendChild(renderDiagnostics(lastData.diagnostics));
      }
      if (activeStage === "graph") stage.appendChild(renderGraph(lastData));
      else if (activeStage === "tokens") stage.appendChild(lastData.tokens ? renderTokens(lastData.tokens) : renderMissingStage("Tokens were not produced."));
      else if (activeStage === "sql") stage.appendChild(lastData.sql ? renderSql(lastData) : renderMissingStage("SQL was not produced."));
      else if (activeStage === "raw") stage.appendChild(renderPre(JSON.stringify(lastData, null, 2)));
      else stage.appendChild(lastData[activeStage] === undefined ? renderMissingStage(labels[activeStage] + " was not produced.") : renderTree(lastData[activeStage] ?? null, activeStage, true));
      output.appendChild(stage);
    }

    function renderDiagnostics(diagnostics) {
      const wrap = document.createElement("div");
      wrap.className = "diagnostics";
      for (const diagnostic of diagnostics) {
        const card = document.createElement("section");
        card.className = "diagnostic";
        const where = diagnostic.line ? "line " + diagnostic.line + (diagnostic.column ? ":" + diagnostic.column : "") : "no location";
        card.innerHTML = '<h3>' + escapeText(diagnostic.stage) + ' failed</h3><p>' + escapeText(diagnostic.message) + '</p><div class="diag-meta"><span class="diag-pill">likely: ' + escapeText(diagnostic.likelyCause) + '</span><span class="diag-pill">category: ' + escapeText(diagnostic.category) + '</span><span class="diag-pill">' + escapeText(where) + '</span></div><p>' + escapeText(diagnostic.hint) + '</p>';
        wrap.appendChild(card);
      }
      return wrap;
    }

    function renderStageTimeline(stages) {
      const wrap = document.createElement("div");
      wrap.className = "timeline";
      for (const stage of stages) {
        const pill = document.createElement("span");
        pill.className = "stage-pill " + stage.status;
        pill.textContent = stage.name + ": " + stage.status;
        if (stage.summary) pill.title = stage.summary;
        wrap.appendChild(pill);
      }
      return wrap;
    }

    function renderMissingStage(message) {
      const div = document.createElement("div");
      div.className = "error";
      div.textContent = message + " Check diagnostics and the stage timeline above.";
      return div;
    }

    function renderGraph(data) {
      const sources = {
        ast: data.ast,
        expandedAst: data.expandedAst,
        ir: data.ir,
        gelIr: data.gelIr,
      };
      if (sources[graphSource] === undefined || sources[graphSource] === null) {
        graphSource = ["ir", "expandedAst", "ast", "gelIr"].find((key) => sources[key] !== undefined && sources[key] !== null) || "ir";
      }
      const wrap = document.createElement("div");
      const toolbar = document.createElement("div");
      toolbar.className = "toolbar";
      toolbar.innerHTML = '<div><div class="toolbar-title">Object graph source</div><p class="hint">Cards are objects. Lines are object/array relationships from the selected pipeline stage.</p></div>';
      const select = document.createElement("select");
      for (const key of ["ast", "expandedAst", "ir", "gelIr"]) {
        const option = document.createElement("option");
        option.value = key;
        option.textContent = labels[key];
        option.selected = key === graphSource;
        option.disabled = sources[key] === undefined || sources[key] === null;
        select.appendChild(option);
      }
      select.addEventListener("change", () => {
        graphSource = select.value;
        renderOutput();
      });
      toolbar.appendChild(select);
      wrap.appendChild(toolbar);

      if (sources[graphSource] === undefined || sources[graphSource] === null) {
        wrap.appendChild(renderMissingStage("No object stage is available to graph."));
        return wrap;
      }

      const graph = buildObjectGraph(sources[graphSource], graphSource);
      const shell = document.createElement("div");
      shell.className = "graph-shell";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.classList.add("graph-lines");
      shell.appendChild(svg);

      const columns = document.createElement("div");
      columns.className = "graph-columns";
      const grouped = groupByDepth(graph.nodes);
      for (const [depth, nodes] of grouped) {
        const column = document.createElement("div");
        column.className = "graph-column";
        const depthLabel = document.createElement("div");
        depthLabel.className = "graph-depth";
        depthLabel.textContent = "Depth " + depth;
        column.appendChild(depthLabel);
        for (const node of nodes) column.appendChild(renderGraphNode(node));
        columns.appendChild(column);
      }
      shell.appendChild(columns);
      wrap.appendChild(shell);
      window.requestAnimationFrame(() => drawGraphEdges(shell, svg, graph.edges));
      return wrap;
    }

    function buildObjectGraph(root, rootName) {
      const nodes = [];
      const edges = [];
      const queue = [];
      const maxNodes = 120;
      const maxDepth = 7;

      function addNode(value, label, depth) {
        if (!isObjectLike(value) || nodes.length >= maxNodes) return null;
        const id = "node-" + nodes.length;
        nodes.push({ id, label, depth, value, info: describeGraphNode(value, label) });
        if (depth < maxDepth) queue.push({ id, value, depth });
        return id;
      }

      addNode(root, rootName, 0);
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const item = queue[cursor];
        const entries = graphEntries(item.value);
        for (const entry of entries) {
          if (!isObjectLike(entry.value)) continue;
          const childId = addNode(entry.value, entry.key, item.depth + 1);
          if (!childId) continue;
          edges.push({ from: item.id, to: childId, label: entry.key });
        }
      }

      return { nodes, edges };
    }

    function graphEntries(value) {
      if (Array.isArray(value)) return value.map((item, index) => ({ key: String(index), value: item }));
      return Object.entries(value).filter(([key]) => key !== "pos");
    }

    function describeGraphNode(value, label) {
      const isArray = Array.isArray(value);
      const kind = isArray ? "array" : typeof value.kind === "string" ? value.kind : "object";
      const primary = !isArray ? value.typeName || value.sourceType || value.name || value.table || value.column || value.id : undefined;
      const title = isArray ? label + " [" + value.length + "]" : primary ? label + " · " + primary : label;
      const chipKeys = ["typeName", "sourceType", "targetType", "table", "column", "name", "id", "cardinality", "multiplicity", "volatility"];
      const chips = [];
      for (const key of chipKeys) {
        if (!isPrimitive(value[key])) continue;
        chips.push({ key, value: String(value[key]) });
      }
      const fields = [];
      const entries = isArray ? value.map((item, index) => [String(index), item]) : Object.entries(value);
      for (const [key, fieldValue] of entries) {
        if (!isPrimitive(fieldValue) || chipKeys.includes(key)) continue;
        fields.push({ key, value: scalarText(fieldValue) });
        if (fields.length >= 7) break;
      }
      return { kind, title, chips, fields, color: colorForKind(kind) };
    }

    function renderGraphNode(node) {
      const card = document.createElement("article");
      card.className = "graph-node";
      card.dataset.nodeId = node.id;
      card.style.borderTopColor = node.info.color;
      const chips = node.info.chips.map((chip) => '<span class="graph-chip">' + escapeText(chip.key) + ': ' + escapeText(chip.value) + '</span>').join("");
      const fields = node.info.fields.map((field) => '<div class="field-row"><strong>' + escapeText(field.key) + '</strong><span>' + escapeText(field.value) + '</span></div>').join("");
      card.innerHTML = '<span class="node-kind" style="background:' + node.info.color + '">' + escapeText(node.info.kind) + '</span><h3>' + escapeText(node.info.title) + '</h3><div class="chips">' + chips + '</div><div class="node-fields">' + fields + '</div>';
      return card;
    }

    function groupByDepth(nodes) {
      const groups = new Map();
      for (const node of nodes) {
        if (!groups.has(node.depth)) groups.set(node.depth, []);
        groups.get(node.depth).push(node);
      }
      return [...groups.entries()].sort((left, right) => left[0] - right[0]);
    }

    function drawGraphEdges(shell, svg, edges) {
      svg.innerHTML = "";
      shell.querySelectorAll(".edge-label").forEach((label) => label.remove());
      const bounds = shell.getBoundingClientRect();
      svg.setAttribute("viewBox", "0 0 " + shell.scrollWidth + " " + shell.scrollHeight);
      svg.style.width = shell.scrollWidth + "px";
      svg.style.height = shell.scrollHeight + "px";
      for (const edge of edges) {
        const from = shell.querySelector('[data-node-id="' + edge.from + '"]');
        const to = shell.querySelector('[data-node-id="' + edge.to + '"]');
        if (!from || !to) continue;
        const a = from.getBoundingClientRect();
        const b = to.getBoundingClientRect();
        const x1 = a.right - bounds.left + shell.scrollLeft;
        const y1 = a.top + a.height / 2 - bounds.top + shell.scrollTop;
        const x2 = b.left - bounds.left + shell.scrollLeft;
        const y2 = b.top + b.height / 2 - bounds.top + shell.scrollTop;
        const mid = Math.max(36, (x2 - x1) / 2);
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", "M " + x1 + " " + y1 + " C " + (x1 + mid) + " " + y1 + ", " + (x2 - mid) + " " + y2 + ", " + x2 + " " + y2);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "rgba(125, 211, 252, 0.42)");
        path.setAttribute("stroke-width", "2");
        svg.appendChild(path);
        if (edge.label.length <= 18) {
          const label = document.createElement("div");
          label.className = "edge-label";
          label.textContent = edge.label;
          label.style.left = (x1 + x2) / 2 + "px";
          label.style.top = (y1 + y2) / 2 + "px";
          shell.appendChild(label);
        }
      }
    }

    function isObjectLike(value) {
      return value !== null && typeof value === "object";
    }

    function isPrimitive(value) {
      return value === null || ["string", "number", "boolean"].includes(typeof value);
    }

    function scalarText(value) {
      if (value === null) return "null";
      if (typeof value === "string") return value.length > 54 ? value.slice(0, 51) + "..." : value;
      return String(value);
    }

    function colorForKind(kind) {
      const palette = ["#7dd3fc", "#86efac", "#fde68a", "#f0abfc", "#fdba74", "#c4b5fd", "#93c5fd"];
      let hash = 0;
      for (let i = 0; i < kind.length; i += 1) hash = (hash * 31 + kind.charCodeAt(i)) >>> 0;
      return palette[hash % palette.length];
    }

    function renderTokens(tokens) {
      const table = document.createElement("table");
      table.innerHTML = "<thead><tr><th>Pos</th><th>Kind</th><th>Lexeme</th><th>Offset</th></tr></thead>";
      const body = document.createElement("tbody");
      for (const token of tokens) {
        const row = document.createElement("tr");
        row.innerHTML = '<td>' + token.line + ':' + token.column + '</td><td><span class="kind">' + escapeText(token.kind) + '</span></td><td>' + escapeText(JSON.stringify(token.lexeme)) + '</td><td>' + token.offset + '</td>';
        body.appendChild(row);
      }
      table.appendChild(body);
      return table;
    }

    function renderSql(data) {
      const sql = data.sql;
      const analysis = analyzeSql(data);
      const wrap = document.createElement("div");
      wrap.className = "sql-explain";

      const grid = document.createElement("div");
      grid.className = "explain-grid";
      grid.appendChild(explainMetric("Branches", String(analysis.branches.length || 1), analysis.polymorphic ? "Polymorphic source expansion: one branch per concrete table." : "Single SQL source branch."));
      grid.appendChild(explainMetric("Projection", String(analysis.projections.length), "Columns or expressions returned by the outer SELECT."));
      grid.appendChild(explainMetric("Lowering", sql.loweringMode, "Lowered through Gel IR SQL."));
      wrap.appendChild(grid);

      const shape = document.createElement("section");
      shape.className = "explain-card";
      shape.innerHTML = '<h3>Execution shape</h3><p>' + escapeText(analysis.summary) + '</p>';
      wrap.appendChild(shape);

      if (analysis.branches.length > 0) {
        const branchPanel = document.createElement("section");
        branchPanel.className = "explain-card";
        branchPanel.innerHTML = '<h3>Source branches</h3>';
        const flow = document.createElement("div");
        flow.className = "branch-flow";
        analysis.branches.forEach((branch, index) => {
          if (index > 0) {
            const union = document.createElement("div");
            union.className = "union-rail";
            union.textContent = "UNION ALL";
            flow.appendChild(union);
          }
          const card = document.createElement("div");
          card.className = "branch-card";
          card.style.borderLeftColor = colorForKind(branch.typeName || branch.table || String(index));
          card.innerHTML = '<h4>' + escapeText(branch.typeName || "SQL branch " + (index + 1)) + '</h4><p>Reads table <code>' + escapeText(branch.table || "unknown") + '</code>' + (branch.columns.length ? ' and emits <code>' + escapeText(branch.columns.join(", ")) + '</code>.' : ".") + '</p>';
          flow.appendChild(card);
        });
        branchPanel.appendChild(flow);
        wrap.appendChild(branchPanel);
      }

      if (analysis.projections.length > 0) {
        const projectionPanel = document.createElement("section");
        projectionPanel.className = "explain-card";
        projectionPanel.innerHTML = '<h3>Outer SELECT projection</h3>';
        const list = document.createElement("div");
        list.className = "projection-list";
        for (const projection of analysis.projections) {
          const row = document.createElement("div");
          row.className = "projection-row";
          row.innerHTML = '<code>' + escapeText(projection.alias || "value") + '</code><span>' + escapeText(projection.expr) + '</span>';
          list.appendChild(row);
        }
        projectionPanel.appendChild(list);
        wrap.appendChild(projectionPanel);
      }

      const code = document.createElement("pre");
      code.className = "sql-highlight";
      code.innerHTML = highlightSql(sql.sql);
      wrap.appendChild(code);
      wrap.appendChild(renderTree({ params: sql.params, loweringMode: sql.loweringMode }, "artifact", true));
      return wrap;
    }

    function explainMetric(label, value, text) {
      const card = document.createElement("section");
      card.className = "explain-card";
      card.innerHTML = '<h3>' + escapeText(label) + '</h3><span class="metric">' + escapeText(value) + '</span><p>' + escapeText(text) + '</p>';
      return card;
    }

    function analyzeSql(data) {
      const sql = data.sql.sql;
      const irTables = Array.isArray(data.ir && data.ir.sourceTables) ? data.ir.sourceTables : [];
      const branches = scanSqlBranches(sql);
      const byType = new Map(branches.map((branch) => [branch.typeName, branch]));
      for (const table of irTables) {
        const existing = byType.get(table.name);
        if (existing) {
          existing.columns = existing.columns.length ? existing.columns : table.columns || [];
          existing.table = existing.table || table.table;
        } else {
          branches.push({ typeName: table.name, table: table.table, columns: table.columns || [] });
        }
      }
      const projections = parseOuterProjections(sql);
      const polymorphic = branches.length > 1 || irTables.length > 1;
      const sourceType = data.ir && data.ir.sourceType ? data.ir.sourceType : undefined;
      const summary = polymorphic
        ? "The EdgeQL source " + (sourceType || "object set") + " spans multiple concrete tables. The compiler emits one SELECT per concrete type and stitches them together with UNION ALL while preserving __source_type."
        : "The SQL reads a single source branch and projects the requested shape columns.";
      return { branches, projections, polymorphic, summary };
    }

    function scanSqlBranches(sql) {
      const branches = [];
      const pattern = /SELECT\\s+'([^']+)'\\s+AS\\s+"__source_type"([\\s\\S]*?)\\s+FROM\\s+"([^"]+)"/gi;
      let match;
      while ((match = pattern.exec(sql)) !== null) {
        branches.push({
          typeName: match[1],
          table: match[3],
          columns: extractAliases(match[2]),
        });
      }
      if (branches.length === 0) {
        const tablePattern = /FROM\\s+"([^"]+)"/gi;
        while ((match = tablePattern.exec(sql)) !== null) {
          branches.push({ typeName: undefined, table: match[1], columns: [] });
        }
      }
      return branches;
    }

    function extractAliases(segment) {
      const columns = [];
      const pattern = /AS\\s+"([^"]+)"/gi;
      let match;
      while ((match = pattern.exec(segment)) !== null) {
        columns.push(match[1]);
      }
      return [...new Set(columns)].filter((column) => column !== "__source_type");
    }

    function parseOuterProjections(sql) {
      const fromIndex = findTopLevelKeyword(sql, "FROM");
      if (fromIndex < 0) return [];
      const selectPrefix = sql.trimStart().slice(0, 6).toUpperCase() === "SELECT" ? sql.indexOf("SELECT") + 6 : 0;
      const projectionText = sql.slice(selectPrefix, fromIndex).trim();
      return splitTopLevelComma(projectionText).map((expr) => {
        const aliasMatch = expr.match(/\\s+AS\\s+"([^"]+)"\\s*$/i);
        return {
          expr: aliasMatch ? expr.slice(0, aliasMatch.index).trim() : expr.trim(),
          alias: aliasMatch ? aliasMatch[1] : undefined,
        };
      }).filter((projection) => projection.expr !== "");
    }

    function findTopLevelKeyword(sql, keyword) {
      const upperKeyword = keyword.toUpperCase();
      let depth = 0;
      let quote = null;
      for (let i = 0; i < sql.length; i += 1) {
        const ch = sql[i];
        if (quote) {
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === "'" || ch === '"') {
          quote = ch;
          continue;
        }
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
        if (depth === 0 && sql.slice(i, i + upperKeyword.length).toUpperCase() === upperKeyword) {
          const before = i === 0 || /\\W/.test(sql[i - 1]);
          const after = i + upperKeyword.length >= sql.length || /\\W/.test(sql[i + upperKeyword.length]);
          if (before && after) return i;
        }
      }
      return -1;
    }

    function splitTopLevelComma(text) {
      const parts = [];
      let depth = 0;
      let quote = null;
      let start = 0;
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (quote) {
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === "'" || ch === '"') {
          quote = ch;
          continue;
        }
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
        else if (ch === "," && depth === 0) {
          parts.push(text.slice(start, i).trim());
          start = i + 1;
        }
      }
      parts.push(text.slice(start).trim());
      return parts.filter(Boolean);
    }

    function highlightSql(sql) {
      const unionMarker = "__SQL_UNION_ALL_MARKER__";
      const escaped = escapeText(sql).replace(/\\bUNION\\s+ALL\\b/gi, unionMarker);
      return escaped
        .replace(/\\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|VALUES|RETURNING|WITH|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AS|AND|OR|NOT|NULL|ORDER|BY|LIMIT|OFFSET|GROUP|HAVING|EXISTS|CASE|WHEN|THEN|ELSE|END)\\b/g, (value) => '<span class="sql-keyword">' + value + '</span>')
        .replace(/(&quot;[^&]+?&quot;)/g, '<span class="sql-ident">$1</span>')
        .replace(/(&#39;[^&]+?&#39;|'[^']*')/g, '<span class="sql-string">$1</span>')
        .split(unionMarker).join('<span class="sql-union">UNION ALL</span>');
    }

    function renderPre(text) {
      const pre = document.createElement("pre");
      pre.className = "sql";
      pre.textContent = text;
      return pre;
    }

    function renderTree(value, name, root) {
      const container = document.createElement("div");
      container.className = root ? "json-tree" : "";
      if (value && typeof value === "object") {
        const details = document.createElement("details");
        details.open = root || (value.kind !== undefined);
        details.className = root ? "root" : "";
        const summary = document.createElement("summary");
        summary.innerHTML = '<span class="key">' + escapeText(name) + '</span> ' + summaryText(value);
        details.appendChild(summary);
        if (Array.isArray(value)) {
          value.forEach((item, index) => details.appendChild(renderTree(item, String(index), false)));
        } else {
          Object.entries(value).forEach(([key, item]) => details.appendChild(renderTree(item, key, false)));
        }
        container.appendChild(details);
      } else {
        const leaf = document.createElement("div");
        leaf.innerHTML = '<span class="key">' + escapeText(name) + '</span>: ' + scalarHtml(value);
        container.appendChild(leaf);
      }
      return container;
    }

    function summaryText(value) {
      if (Array.isArray(value)) return '<span class="null">Array(' + value.length + ")</span>";
      if (value && typeof value === "object" && value.kind !== undefined) return '<span class="kind">' + escapeText(String(value.kind)) + '</span>';
      return '<span class="null">Object</span>';
    }

    function scalarHtml(value) {
      if (value === null) return '<span class="null">null</span>';
      if (typeof value === "string") return '<span class="string">"' + escapeText(value) + '"</span>';
      if (typeof value === "number") return '<span class="number">' + value + '</span>';
      if (typeof value === "boolean") return '<span class="boolean">' + value + '</span>';
      if (value === undefined) return '<span class="null">undefined</span>';
      return escapeText(String(value));
    }

    function escapeText(value) {
      return String(value).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
    }

    renderTabs();
    runButton.addEventListener("click", run);
    document.getElementById("query").addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") run();
    });
    run();
  </script>
</body>
</html>`;

const escapeHtml = (value: string): string => value.replace(/[&<>"]/g, (ch) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
}[ch] ?? ch));

const printUsage = (): void => {
  process.stderr.write(`Usage:\n`);
  process.stderr.write(`  npm run debug:pipeline:browser -- --schema tests/schemas/cards.esdl\n\n`);
  process.stderr.write(`Options:\n`);
  process.stderr.write(`  -p, --port <port>       Port to listen on (default: 4179)\n`);
  process.stderr.write(`  -s, --schema <path>     Default schema path\n`);
  process.stderr.write(`  -q, --query <edgeql>    Initial query text\n`);
  process.stderr.write(`      --target <target>   sqlite or d1 (default: sqlite)\n`);
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
  process.stderr.write(`debug-pipeline-browser failed: ${message}\n`);
  process.exit(1);
}
