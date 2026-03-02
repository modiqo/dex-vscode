import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";

export interface FlowParam {
  name: string;
  type: string;
  required: boolean;
  default?: string;
  description?: string;
}

export interface FlowInfo {
  name: string;
  path: string;
  description?: string;
  params: FlowParam[];
}

/** Parse @dex-frontmatter YAML block from a flow's main.ts */
export function parseFlowFrontmatter(flowPath: string): FlowInfo {
  const name = flowPath.split("/").slice(-2)[0] ?? "flow";
  const info: FlowInfo = { name, path: flowPath, params: [] };

  let source: string;
  try {
    source = fs.readFileSync(flowPath, "utf-8");
  } catch {
    return info;
  }

  // Extract the YAML block between @dex-frontmatter\n * ---\n and the closing * ---
  const fmMatch = source.match(/@dex-frontmatter\s*\n\s*\*\s*---\n([\s\S]*?)\n\s*\*\s*---/);
  if (!fmMatch) { return info; }

  // Strip leading " * " from each line
  const yaml = fmMatch[1]
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, ""))
    .join("\n");

  // Extract description
  const descMatch = yaml.match(/^description:\s*"(.+?)"\s*$/m);
  if (descMatch) { info.description = descMatch[1]; }

  // Extract parameters block
  const paramsIdx = yaml.indexOf("  parameters:");
  if (paramsIdx === -1) { return info; }

  const paramsBlock = yaml.slice(paramsIdx + "  parameters:".length);

  // Each parameter starts with "  - name:"
  const paramRegex = /- name:\s*(\S+)([\s\S]*?)(?=\n\s*- name:|\n\s*\w+:|$)/g;
  let match: RegExpExecArray | null;

  while ((match = paramRegex.exec(paramsBlock)) !== null) {
    const paramName = match[1];
    const body = match[2];

    const typeMatch = body.match(/type:\s*(\S+)/);
    const requiredMatch = body.match(/required:\s*(true|false)/);
    const defaultMatch = body.match(/default:\s*"?([^"\n]+)"?/);
    const descM = body.match(/description:\s*"(.+?)"/);

    info.params.push({
      name: paramName,
      type: typeMatch?.[1] ?? "string",
      required: requiredMatch ? requiredMatch[1] === "true" : true,
      default: defaultMatch?.[1]?.trim(),
      description: descM?.[1],
    });
  }

  return info;
}

/** Show the Run Flow panel — form + inline execution + results view */
export function showRunFlowPanel(flowInfo: FlowInfo): void {
  const panel = vscode.window.createWebviewPanel(
    "modiqo.runFlow",
    `Run: ${flowInfo.name}`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  panel.webview.html = buildRunFlowHtml(flowInfo);

  let activeProc: ReturnType<typeof spawn> | null = null;

  panel.webview.onDidReceiveMessage((msg) => {
    if (msg.type === "run") {
      const args: string[] = msg.args;
      activeProc = runFlow(flowInfo, args, panel);
    } else if (msg.type === "cancel") {
      if (activeProc) {
        activeProc.kill();
        activeProc = null;
      }
      panel.dispose();
    } else if (msg.type === "kill") {
      if (activeProc) {
        activeProc.kill();
        activeProc = null;
      }
    } else if (msg.type === "open-terminal") {
      // Re-run in terminal for interactive use
      const { args: tArgs, flowPath } = msg;
      const terminal = vscode.window.createTerminal({ name: `dex: ${flowInfo.name}` });
      terminal.show();
      const quotedArgs = (tArgs as string[]).map((a: string) => (a.includes(" ") ? `"${a}"` : a)).join(" ");
      terminal.sendText(
        quotedArgs
          ? `dex deno run --allow-all "${flowPath}" ${quotedArgs}`
          : `dex deno run --allow-all "${flowPath}"`
      );
    }
  });

  panel.onDidDispose(() => {
    if (activeProc) { activeProc.kill(); activeProc = null; }
  });
}

/** Spawn the flow, stream output to the webview, capture JSON result */
function runFlow(
  flowInfo: FlowInfo,
  args: string[],
  panel: vscode.WebviewPanel
): ReturnType<typeof spawn> {
  const dexPath = resolveDexPath();

  // Spawn human-readable run for streaming output
  const proc = spawn(dexPath, ["deno", "run", "--allow-all", flowInfo.path, ...args], {
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    cwd: path.dirname(flowInfo.path),
  });

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  proc.stdout?.on("data", (chunk: Buffer) => {
    const text = stripAnsi(chunk.toString());
    stdoutLines.push(...text.split("\n").filter((l) => l.length > 0));
    panel.webview.postMessage({ type: "stdout", text });
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = stripAnsi(chunk.toString());
    stderrLines.push(...text.split("\n").filter((l) => l.length > 0));
    panel.webview.postMessage({ type: "stderr", text });
  });

  proc.on("close", (code) => {
    const allOutput = stdoutLines.join("\n");

    // Try to extract JSON result via --output=json separately
    spawnJsonRun(dexPath, flowInfo.path, args, (jsonResult) => {
      panel.webview.postMessage({
        type: "done",
        exitCode: code,
        jsonResult,
        summaryLines: extractSummaryLines(allOutput),
      });
    });
  });

  proc.on("error", (err) => {
    panel.webview.postMessage({ type: "error", message: err.message });
  });

  panel.webview.postMessage({ type: "start", flowName: flowInfo.name, args });

  return proc;
}

/** Run the same flow with --output=json to get structured result */
function spawnJsonRun(
  dexPath: string,
  flowPath: string,
  args: string[],
  callback: (result: unknown) => void
): void {
  const proc = spawn(
    dexPath,
    ["deno", "run", "--allow-all", flowPath, ...args, "--output=json"],
    {
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      cwd: path.dirname(flowPath),
    }
  );

  let buf = "";
  proc.stdout?.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
  proc.on("close", () => {
    try {
      // Find the last JSON object in stdout (ignore any preamble text)
      const jsonMatch = buf.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        callback(JSON.parse(jsonMatch[0]));
      } else {
        callback(null);
      }
    } catch {
      callback(null);
    }
  });
  proc.on("error", () => callback(null));
}

/** Pull out the last few lines of human output as a quick summary */
function extractSummaryLines(output: string): string[] {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("✓") && !l.match(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/));

  // Prefer lines with summary markers
  const summaryIdx = lines.findLastIndex(
    (l) => l.includes("Summary") || l.includes("═") || l.includes("📊")
  );
  if (summaryIdx >= 0) {
    return lines.slice(summaryIdx).slice(0, 8);
  }
  // Fallback: last 6 meaningful lines
  return lines.slice(-6);
}

function resolveDexPath(): string {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".local", "bin", "dex"),
    "/usr/local/bin/dex",
    "dex",
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) { return c; }
    } catch { /* skip */ }
  }
  return "dex";
}

/** Strip ANSI escape codes and collapse carriage-return spinner overwrites.
 *
 * The dex task-queue spinner writes lines like:
 *   \r  ⠋ fetch-details  0.1s  [running]
 *   \r  ⠙ fetch-details  0.2s  [running]
 *   \r  ✔ fetch-details  7.5s  completed
 *
 * Each \r moves to the start of the current line, overwriting it.
 * We process these so only the final state of each line is kept.
 */
function stripAnsi(s: string): string {
  // Remove ANSI escape sequences (SGR, cursor movement, erase-line etc.)
  // eslint-disable-next-line no-control-regex
  let out = s.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, "");

  // Simulate carriage-return overwrite: split on \n, then within each
  // "physical line" keep only the last \r-separated segment.
  out = out
    .split("\n")
    .map((line) => {
      const parts = line.split("\r");
      return parts[parts.length - 1];
    })
    .join("\n");

  return out;
}

// ── HTML ──────────────────────────────────────────────────────────────────────

function buildRunFlowHtml(flow: FlowInfo): string {
  const fields = flow.params
    .map((p, i) => {
      const inputType = p.type === "number" ? "number" : "text";
      const placeholder = p.default ?? (p.required ? "required" : "optional");
      const defaultVal = p.default ?? "";
      return `
        <div class="field">
          <div class="field-header">
            <label for="param-${i}">${escHtml(p.name)}${p.required ? '<span class="req">*</span>' : ""}</label>
            <span class="type-badge">${escHtml(p.type)}</span>
          </div>
          ${p.description ? `<div class="field-desc">${escHtml(p.description)}</div>` : ""}
          <input
            id="param-${i}"
            type="${inputType}"
            placeholder="${escHtml(placeholder)}"
            value="${escHtml(defaultVal)}"
            data-required="${p.required}"
            data-name="${escHtml(p.name)}"
            autocomplete="off"
          />
          <div class="validation-msg"></div>
        </div>`;
    })
    .join("\n");

  const descHtml = flow.description
    ? `<p class="flow-desc">${escHtml(flow.description)}</p>`
    : "";

  const noParams = flow.params.length === 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root {
    --fg: var(--vscode-foreground);
    --fg-dim: var(--vscode-descriptionForeground);
    --bg: var(--vscode-editor-background);
    --border: var(--vscode-panel-border, #3c3c3c);
    --accent: var(--vscode-button-background, #0e639c);
    --accent-fg: var(--vscode-button-foreground, #fff);
    --card-bg: var(--vscode-sideBar-background, #252526);
    --input-bg: var(--vscode-input-background, #3c3c3c);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, #555);
    --error: var(--vscode-inputValidation-errorBorder, #f44747);
    --success: #4ec9b0;
    --orange: #ce9178;
    --mono: var(--vscode-editor-font-family, monospace);
    --radius: 8px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--fg);
    background: var(--bg);
    padding: 28px 32px 48px;
    max-width: 760px;
  }

  /* ── Shared ── */
  .flow-name { font-size: 1.25em; font-weight: 700; margin-bottom: 6px; }
  .flow-desc { font-size: 0.84em; color: var(--fg-dim); line-height: 1.5; margin-bottom: 4px; }
  hr { border: none; border-top: 1px solid var(--border); margin: 20px 0; }
  .section-label {
    font-size: 0.68em; text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--fg-dim); margin-bottom: 14px;
  }

  /* ── Form view ── */
  #view-form { display: block; }
  .fields { display: flex; flex-direction: column; gap: 18px; }
  .field-header { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
  label { font-size: 0.9em; font-weight: 600; }
  .req { color: var(--error); margin-left: 1px; }
  .type-badge {
    font-size: 0.68em; font-family: var(--mono); background: var(--card-bg);
    border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px; color: var(--fg-dim);
  }
  .field-desc { font-size: 0.78em; color: var(--fg-dim); margin-bottom: 6px; line-height: 1.4; }
  input {
    width: 100%; background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 4px;
    padding: 7px 10px; font-size: 0.9em; font-family: inherit; outline: none;
    transition: border-color 0.15s;
  }
  input:focus { border-color: var(--accent); }
  input.error { border-color: var(--error); }
  .validation-msg { font-size: 0.75em; color: var(--error); margin-top: 4px; display: none; }
  .validation-msg.visible { display: block; }
  .actions { display: flex; gap: 10px; margin-top: 24px; }
  button {
    padding: 8px 20px; border-radius: 4px; border: none;
    font-size: 0.9em; cursor: pointer; font-family: inherit; font-weight: 500;
  }
  .btn-primary { background: var(--accent); color: var(--accent-fg); }
  .btn-primary:hover { opacity: 0.88; }
  .btn-ghost {
    background: transparent; color: var(--fg-dim); border: 1px solid var(--border);
  }
  .btn-ghost:hover { color: var(--fg); border-color: var(--fg-dim); }
  .btn-danger { background: transparent; color: #f44747; border: 1px solid #f44747; }
  .btn-danger:hover { background: rgba(244,71,71,0.08); }
  .cmd-preview {
    margin-top: 20px; background: var(--card-bg);
    border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px;
  }
  .cmd-preview-label { font-size: 0.68em; text-transform: uppercase; letter-spacing: 0.1em; color: var(--fg-dim); margin-bottom: 6px; }
  .cmd-preview-text { font-family: var(--mono); font-size: 0.78em; color: var(--fg); word-break: break-all; white-space: pre-wrap; }

  /* ── Running view ── */
  #view-running { display: none; }
  .run-header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
  .spinner {
    width: 18px; height: 18px; border: 2px solid var(--border);
    border-top-color: var(--accent); border-radius: 50%;
    animation: spin 0.7s linear infinite; flex-shrink: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .run-title { font-size: 1.1em; font-weight: 600; }
  .run-subtitle { font-size: 0.8em; color: var(--fg-dim); }
  .log-box {
    background: var(--card-bg); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 14px 16px;
    font-family: var(--mono); font-size: 0.8em; line-height: 1.6;
    max-height: 320px; overflow-y: auto; white-space: pre-wrap; word-break: break-word;
  }
  .log-line { color: var(--fg); }
  .log-line.dim { color: var(--fg-dim); }
  .log-line.ok { color: var(--success); }
  .log-line.err { color: var(--error); }

  /* ── Results view ── */
  #view-results { display: none; }
  .result-status {
    display: flex; align-items: center; gap: 10px;
    padding: 14px 18px; border-radius: var(--radius); margin-bottom: 20px;
    border: 1px solid var(--border);
  }
  .result-status.ok { border-color: var(--success); background: rgba(78,201,176,0.07); }
  .result-status.fail { border-color: var(--error); background: rgba(244,71,71,0.07); }
  .status-icon { font-size: 1.3em; }
  .status-text { font-weight: 600; font-size: 0.95em; }
  .status-sub { font-size: 0.78em; color: var(--fg-dim); margin-top: 2px; }

  .result-section { margin-bottom: 24px; }
  .result-section-title {
    font-size: 0.68em; text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--fg-dim); margin-bottom: 12px;
  }

  /* JSON result table */
  .json-table { width: 100%; border-collapse: collapse; }
  .json-table td {
    padding: 7px 10px; border-bottom: 1px solid var(--border);
    font-size: 0.87em; vertical-align: top;
  }
  .json-table td:first-child {
    font-family: var(--mono); color: var(--fg-dim);
    width: 38%; font-size: 0.82em;
  }
  .json-table td:last-child { font-weight: 500; }
  .json-table tr:last-child td { border-bottom: none; }

  /* Array items */
  .result-list { display: flex; flex-direction: column; gap: 8px; }
  .result-card {
    background: var(--card-bg); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 12px 14px;
  }
  .result-card-title { font-weight: 600; font-size: 0.92em; margin-bottom: 4px; }
  .result-card-meta { font-size: 0.78em; color: var(--fg-dim); line-height: 1.6; }
  .result-card-link { font-size: 0.78em; color: var(--accent); margin-top: 4px; display: block; }

  /* Raw output toggle */
  .raw-toggle {
    font-size: 0.78em; color: var(--fg-dim); cursor: pointer;
    background: none; border: none; padding: 0; font-family: inherit;
    text-decoration: underline; margin-bottom: 8px;
  }
  .raw-box {
    background: var(--card-bg); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 12px 14px;
    font-family: var(--mono); font-size: 0.78em; line-height: 1.6;
    max-height: 260px; overflow-y: auto; white-space: pre-wrap; word-break: break-word;
    display: none;
  }
  .raw-box.visible { display: block; }

  .result-actions { display: flex; gap: 10px; margin-top: 24px; flex-wrap: wrap; }
</style>
</head>
<body>

<!-- ── Form view ── -->
<div id="view-form">
  <div class="flow-name">${escHtml(flow.name)}</div>
  ${descHtml}

  ${
    noParams
      ? `<hr><p style="color:var(--fg-dim);font-size:0.87em;margin-bottom:20px;">This flow takes no parameters.</p>`
      : `<hr><div class="section-label">Parameters</div><div class="fields">${fields}</div>`
  }

  <div class="actions">
    <button class="btn-primary" id="btn-run">▶ Run Flow</button>
    <button class="btn-ghost" id="btn-cancel">Cancel</button>
  </div>

  <div class="cmd-preview">
    <div class="cmd-preview-label">Command preview</div>
    <div class="cmd-preview-text" id="preview">dex deno run --allow-all "${escHtml(flow.path)}"</div>
  </div>
</div>

<!-- ── Running view ── -->
<div id="view-running">
  <div class="run-header">
    <div class="spinner" id="spinner"></div>
    <div>
      <div class="run-title" id="run-title">Running ${escHtml(flow.name)}…</div>
      <div class="run-subtitle" id="run-args"></div>
    </div>
    <button class="btn-danger" style="margin-left:auto" id="btn-kill">Stop</button>
  </div>
  <div class="log-box" id="log-box"></div>
</div>

<!-- ── Results view ── -->
<div id="view-results">
  <div id="result-status" class="result-status ok">
    <span class="status-icon" id="status-icon">✓</span>
    <div>
      <div class="status-text" id="status-text">Completed</div>
      <div class="status-sub" id="status-sub"></div>
    </div>
  </div>

  <div id="result-content"></div>

  <div class="result-actions">
    <button class="btn-primary" id="btn-run-again">▶ Run Again</button>
    <button class="btn-ghost" id="btn-terminal">Open in Terminal</button>
  </div>
</div>

<script>
const vscode = acquireVsCodeApi();
const flowPath = ${JSON.stringify(flow.path)};
const flowName = ${JSON.stringify(flow.name)};
let lastArgs = [];
let logLines = [];
const MAX_LOG_LINES = 200;

// Spinner chars used by the dex task queue — declared here so all functions can access them
const SPINNER_CHARS = new Set(['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']);

function getInputs() {
  return Array.from(document.querySelectorAll('#view-form input[data-name]'));
}

function buildArgs() {
  return getInputs().map(inp => inp.value.trim());
}

function updatePreview() {
  const args = buildArgs().filter(Boolean);
  const q = args.map(a => a.includes(' ') ? '"'+a+'"' : a).join(' ');
  document.getElementById('preview').textContent =
    q ? 'dex deno run --allow-all "'+flowPath+'" '+q
      : 'dex deno run --allow-all "'+flowPath+'"';
}
getInputs().forEach(inp => inp.addEventListener('input', updatePreview));
updatePreview();

function submitForm() {
  let valid = true;
  getInputs().forEach(inp => {
    const required = inp.dataset.required === 'true';
    const msg = inp.parentElement.querySelector('.validation-msg');
    if (required && !inp.value.trim()) {
      inp.classList.add('error');
      if (msg) { msg.textContent = inp.dataset.name + ' is required'; msg.classList.add('visible'); }
      valid = false;
    } else {
      inp.classList.remove('error');
      if (msg) { msg.classList.remove('visible'); }
    }
  });
  if (!valid) return;
  lastArgs = buildArgs();
  vscode.postMessage({ type: 'run', args: lastArgs });
}

document.getElementById('btn-run').addEventListener('click', submitForm);
document.getElementById('btn-cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
document.getElementById('btn-kill').addEventListener('click', () => vscode.postMessage({ type: 'kill' }));
document.getElementById('btn-run-again').addEventListener('click', () => showView('form'));
document.getElementById('btn-terminal').addEventListener('click', () => {
  vscode.postMessage({ type: 'open-terminal', args: lastArgs, flowPath });
});

getInputs().forEach(inp => {
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') submitForm(); });
});

function showView(name) {
  ['form','running','results'].forEach(v => {
    document.getElementById('view-'+v).style.display = v === name ? 'block' : 'none';
  });
}

/** Extract task name from a spinner/task line: "⠋ fetch-details  0.1s  [running]" → "fetch-details" */
function spinnerTaskName(line) {
  const m = line.match(/^[^\s]+\s+([^\s]+)\s+[\d.]+s/);
  return m ? m[1] : null;
}

function appendLog(text, cls) {
  const box = document.getElementById('log-box');
  // Split on actual newlines; also handle \r-prefixed spinner chunks
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const lineCls = cls || classifyLine(trimmed);
    const taskName = spinnerTaskName(trimmed);
    const first = [...trimmed][0];
    const isTaskLine = taskName && (SPINNER_CHARS.has(first) || first === '✔' || first === '✓' || first === '✗');

    if (isTaskLine) {
      // Find and update existing entry for this task, or add new
      const existing = logLines.findLastIndex(l => spinnerTaskName(l.text) === taskName);
      if (existing >= 0) {
        logLines[existing] = { text: trimmed, cls: lineCls };
      } else {
        if (logLines.length >= MAX_LOG_LINES) { logLines.shift(); }
        logLines.push({ text: trimmed, cls: lineCls });
      }
    } else {
      if (logLines.length >= MAX_LOG_LINES) { logLines.shift(); }
      logLines.push({ text: trimmed, cls: lineCls });
    }
  }

  box.innerHTML = logLines.map(l =>
    '<div class="log-line '+ l.cls +'">' + escHtml(l.text) + '</div>'
  ).join('');
  box.scrollTop = box.scrollHeight;
}

function classifyLine(line) {
  const first = [...line][0];
  if (first === '✓' || first === '✔') return 'ok';
  if (first === '✗' || line.startsWith('Error') || line.startsWith('error')) return 'err';
  if (SPINNER_CHARS.has(first) || line.startsWith('[')) return 'dim';
  return '';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderResults(exitCode, jsonResult, summaryLines) {
  const ok = exitCode === 0;
  const statusEl = document.getElementById('result-status');
  statusEl.className = 'result-status ' + (ok ? 'ok' : 'fail');
  document.getElementById('status-icon').textContent = ok ? '✓' : '✗';
  document.getElementById('status-text').textContent = ok ? 'Completed successfully' : 'Flow failed';
  document.getElementById('status-sub').textContent =
    lastArgs.filter(Boolean).length
      ? 'Args: ' + lastArgs.filter(Boolean).join('  ·  ')
      : 'No arguments';

  const content = document.getElementById('result-content');
  content.innerHTML = '';

  if (jsonResult) {
    const sec = makeSection('Result');
    sec.appendChild(renderJsonResult(jsonResult));
    content.appendChild(sec);
  } else if (summaryLines && summaryLines.length > 0) {
    const sec = makeSection('Output');
    const pre = document.createElement('div');
    pre.className = 'log-box';
    pre.style.maxHeight = '180px';
    pre.innerHTML = summaryLines.map(l =>
      '<div class="log-line">' + escHtml(l) + '</div>'
    ).join('');
    sec.appendChild(pre);
    content.appendChild(sec);
  }

  // Raw log toggle
  const rawSec = makeSection('');
  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'raw-toggle';
  toggleBtn.textContent = 'Show full output';
  const rawBox = document.createElement('div');
  rawBox.className = 'raw-box';
  rawBox.innerHTML = logLines.map(l =>
    '<div class="log-line '+l.cls+'">' + escHtml(l.text) + '</div>'
  ).join('');
  toggleBtn.onclick = () => {
    const visible = rawBox.classList.toggle('visible');
    toggleBtn.textContent = visible ? 'Hide full output' : 'Show full output';
  };
  rawSec.appendChild(toggleBtn);
  rawSec.appendChild(rawBox);
  content.appendChild(rawSec);
}

function makeSection(title) {
  const div = document.createElement('div');
  div.className = 'result-section';
  if (title) {
    const h = document.createElement('div');
    h.className = 'result-section-title';
    h.textContent = title;
    div.appendChild(h);
  }
  return div;
}

function renderJsonResult(data) {
  // If top-level has an array property with objects — render as cards
  for (const [key, val] of Object.entries(data)) {
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
      return renderCardList(val);
    }
  }
  // Otherwise render as key-value table
  return renderKVTable(data);
}

function renderCardList(items) {
  const list = document.createElement('div');
  list.className = 'result-list';
  const MAX = 20;
  items.slice(0, MAX).forEach((item, i) => {
    const card = document.createElement('div');
    card.className = 'result-card';

    // Title: try name, title, fullName, id
    const title = item.name || item.title || item.fullName || item.id || ('#' + (i+1));
    const titleEl = document.createElement('div');
    titleEl.className = 'result-card-title';
    titleEl.textContent = String(title);
    card.appendChild(titleEl);

    // Meta: collect interesting scalar fields
    const skip = new Set(['name','title','fullName','id','url','html_url','link']);
    const metaParts = Object.entries(item)
      .filter(([k, v]) => !skip.has(k) && typeof v !== 'object' && v !== null && v !== '' && v !== undefined)
      .slice(0, 6)
      .map(([k, v]) => escHtml(k) + ': ' + escHtml(String(v)));
    if (metaParts.length) {
      const meta = document.createElement('div');
      meta.className = 'result-card-meta';
      meta.innerHTML = metaParts.join('  ·  ');
      card.appendChild(meta);
    }

    // Link
    const linkUrl = item.url || item.html_url || item.link;
    if (linkUrl) {
      const link = document.createElement('a');
      link.className = 'result-card-link';
      link.href = String(linkUrl);
      link.textContent = String(linkUrl);
      card.appendChild(link);
    }

    list.appendChild(card);
  });
  if (items.length > MAX) {
    const more = document.createElement('div');
    more.style.cssText = 'font-size:0.78em;color:var(--fg-dim);padding:6px 0';
    more.textContent = '… and ' + (items.length - MAX) + ' more';
    list.appendChild(more);
  }
  return list;
}

function renderKVTable(data) {
  const table = document.createElement('table');
  table.className = 'json-table';
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'object' && !Array.isArray(v)) continue; // skip nested objects
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.textContent = k;
    const td2 = document.createElement('td');
    if (Array.isArray(v)) {
      td2.textContent = v.slice(0,5).map(String).join(', ') + (v.length > 5 ? ' …' : '');
    } else {
      td2.textContent = String(v ?? '—');
    }
    tr.appendChild(td1);
    tr.appendChild(td2);
    table.appendChild(tr);
  }
  return table;
}

// ── Message handler ──
window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'start') {
    logLines = [];
    showView('running');
    document.getElementById('run-title').textContent = 'Running ' + escHtml(msg.flowName) + '…';
    document.getElementById('run-args').textContent =
      msg.args.filter(Boolean).length ? 'Args: ' + msg.args.filter(Boolean).join('  ·  ') : '';
  } else if (msg.type === 'stdout') {
    appendLog(msg.text);
  } else if (msg.type === 'stderr') {
    appendLog(msg.text, 'dim');
  } else if (msg.type === 'done') {
    document.getElementById('spinner').style.animation = 'none';
    document.getElementById('spinner').style.borderTopColor = msg.exitCode === 0 ? 'var(--success)' : 'var(--error)';
    renderResults(msg.exitCode, msg.jsonResult, msg.summaryLines);
    showView('results');
  } else if (msg.type === 'error') {
    appendLog('Error: ' + msg.message, 'err');
  }
});
</script>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
