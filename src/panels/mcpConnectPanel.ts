import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { spawn } from "child_process";

function resolveDexPath(): string {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".local", "bin", "dex"),
    "/usr/local/bin/dex",
    "dex",
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) { return c; } } catch { /* skip */ }
  }
  return "dex";
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*[mGKHFJST]/g, "").replace(/\r[^\n]/g, "");
}

/** Classify a CLI output line into a step transition or log entry */
function classifyLine(line: string): { step?: string; log?: string; success?: boolean; error?: string } {
  const l = line.toLowerCase();
  if (l.includes("discovering oauth")) return { step: "oauth-discover" };
  if (l.includes("oauth endpoints discovered") || l.includes("oauth discovered via")) return { log: line };
  if (l.includes("dynamic client registration available")) return { log: line };
  if (l.includes("registering oauth client")) return { step: "dcr" };
  if (l.includes("client id")) return { log: line };
  if (l.includes("authorizing with oauth") || l.includes("opening browser")) return { step: "oauth-auth" };
  if (l.includes("introspecting mcp server") || l.includes("initializing mcp session")) return { step: "introspect" };
  if (l.includes("building adapter")) return { step: "build" };
  if (l.includes("adapter created successfully")) return { success: true };
  if (l.includes("token stored")) return { log: line };
  if (l.includes("tools:") || l.includes("server information")) return { log: line };
  if (l.includes("error") || l.includes("failed")) return { error: line };
  return { log: line };
}

export async function showMcpConnectPanel(
  adapterId: string,
  specUrl: string,
  onAdapterCreated?: () => void,
): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "modiqo.mcpConnect",
    `Connecting ${adapterId}`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  panel.webview.html = buildHtml(adapterId, specUrl);

  const dexPath = resolveDexPath();
  const args = ["adapter", "new-from-mcp", adapterId, specUrl];
  const proc = spawn(dexPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  const send = (msg: object) => {
    try { panel.webview.postMessage(msg); } catch { /* panel disposed */ }
  };

  proc.stdout?.on("data", (chunk: Buffer) => {
    const text = stripAnsi(chunk.toString());
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) { continue; }
      const classified = classifyLine(line);
      if (classified.success) {
        send({ type: "success" });
      } else if (classified.error) {
        send({ type: "log", text: line, isError: true });
      } else if (classified.step) {
        send({ type: "step", step: classified.step });
        send({ type: "log", text: line });
      } else if (classified.log) {
        send({ type: "log", text: line });
      }
    }
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = stripAnsi(chunk.toString());
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) { continue; }
      send({ type: "log", text: line, isError: line.toLowerCase().includes("error") });
    }
  });

  proc.on("close", (code) => {
    if (code === 0) {
      send({ type: "success" });
      onAdapterCreated?.();
    } else if (code !== null) {
      send({ type: "failed", code });
    }
  });

  proc.on("error", (err) => {
    send({ type: "failed", code: -1, message: err.message });
  });

  // If user closes the panel, kill the process
  panel.onDidDispose(() => {
    try { proc.kill(); } catch { /* ignore */ }
  });
}

function buildHtml(adapterId: string, specUrl: string): string {
  const steps = [
    { id: "oauth-discover", label: "Discover OAuth endpoints" },
    { id: "dcr",           label: "Register OAuth client (DCR)" },
    { id: "oauth-auth",    label: "Authorize in browser" },
    { id: "introspect",    label: "Introspect MCP server" },
    { id: "build",         label: "Build adapter" },
  ];

  const stepsHtml = steps.map((s, i) => `
    <div class="step" id="step-${s.id}" data-index="${i}">
      <div class="step-icon" id="icon-${s.id}">
        <span class="step-num">${i + 1}</span>
      </div>
      <div class="step-label">${s.label}</div>
    </div>
  `).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root {
    --fg: var(--vscode-foreground);
    --fg-dim: var(--vscode-descriptionForeground);
    --bg: var(--vscode-editor-background);
    --border: var(--vscode-widget-border, #333);
    --accent: var(--vscode-textLink-foreground, #4e9bf5);
    --success: #4caf50;
    --error: #f44336;
    --warn: #ff9800;
    --card-bg: var(--vscode-editorWidget-background, var(--bg));
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
    --terminal-bg: #0d1117;
    --terminal-fg: #e6edf3;
  }

  * { box-sizing: border-box; }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--fg);
    background: var(--bg);
    margin: 0;
    padding: 32px 40px;
    line-height: 1.6;
  }

  .header { margin-bottom: 28px; }
  .header h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 4px 0; }
  .header .sub { color: var(--fg-dim); font-size: 0.88em; }

  /* Steps track */
  .steps {
    display: flex;
    align-items: flex-start;
    gap: 0;
    margin-bottom: 28px;
    position: relative;
  }

  .steps::before {
    content: '';
    position: absolute;
    top: 16px;
    left: 16px;
    right: 16px;
    height: 2px;
    background: var(--border);
    z-index: 0;
  }

  .step {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    position: relative;
    z-index: 1;
  }

  .step-icon {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 2px solid var(--border);
    background: var(--bg);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.8em;
    font-weight: 600;
    color: var(--fg-dim);
    transition: all 0.3s ease;
    flex-shrink: 0;
  }

  .step-label {
    font-size: 0.72em;
    color: var(--fg-dim);
    text-align: center;
    line-height: 1.3;
    transition: color 0.3s ease;
    max-width: 90px;
  }

  /* Step states */
  .step.active .step-icon {
    border-color: var(--accent);
    background: var(--accent);
    color: #fff;
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 20%, transparent);
    animation: pulse 1.5s infinite;
  }

  .step.active .step-label { color: var(--accent); font-weight: 600; }

  .step.done .step-icon {
    border-color: var(--success);
    background: var(--success);
    color: #fff;
  }

  .step.done .step-label { color: var(--success); }

  .step.error .step-icon {
    border-color: var(--error);
    background: var(--error);
    color: #fff;
  }

  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 20%, transparent); }
    50%       { box-shadow: 0 0 0 8px color-mix(in srgb, var(--accent) 5%, transparent); }
  }

  /* Status banner */
  .status-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    border-radius: 6px;
    background: var(--card-bg);
    border: 1px solid var(--border);
    margin-bottom: 20px;
    font-size: 0.9em;
    min-height: 42px;
  }

  .status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--fg-dim);
    transition: background 0.3s;
  }
  .status-dot.running { background: var(--accent); animation: blink 1s infinite; }
  .status-dot.success { background: var(--success); }
  .status-dot.error   { background: var(--error); }

  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }

  /* Terminal output */
  .terminal {
    background: var(--terminal-bg);
    color: var(--terminal-fg);
    border-radius: 8px;
    padding: 16px;
    font-family: var(--vscode-editor-font-family, 'Menlo', monospace);
    font-size: 0.82em;
    line-height: 1.6;
    max-height: 320px;
    overflow-y: auto;
    border: 1px solid #30363d;
    scroll-behavior: smooth;
  }

  .terminal-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid #30363d;
  }

  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .dot-red    { background: #ff5f57; }
  .dot-yellow { background: #febc2e; }
  .dot-green  { background: #28c840; }

  .terminal-title {
    flex: 1;
    text-align: center;
    font-size: 0.85em;
    color: #8b949e;
  }

  .log-line { margin: 0; padding: 1px 0; white-space: pre-wrap; word-break: break-all; }
  .log-line.err { color: #f85149; }
  .log-line.dim { color: #8b949e; }
  .log-line.ok  { color: #3fb950; }

  /* Success / error state */
  .result-banner {
    display: none;
    padding: 16px 20px;
    border-radius: 8px;
    margin-top: 20px;
    font-weight: 600;
    font-size: 1em;
    align-items: center;
    gap: 12px;
  }
  .result-banner.success { display: flex; background: color-mix(in srgb, var(--success) 12%, var(--bg)); border: 1px solid var(--success); color: var(--success); }
  .result-banner.error   { display: flex; background: color-mix(in srgb, var(--error) 12%, var(--bg)); border: 1px solid var(--error); color: var(--error); }

  .result-icon { font-size: 1.4em; }

  .browser-hint {
    display: none;
    margin-top: 14px;
    padding: 10px 14px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--warn) 10%, var(--bg));
    border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
    font-size: 0.86em;
    color: var(--warn);
    gap: 8px;
    align-items: flex-start;
  }
  .browser-hint.visible { display: flex; }
</style>
</head>
<body>

<div class="header">
  <h1>Connecting <strong>${adapterId}</strong></h1>
  <div class="sub">${specUrl}</div>
</div>

<div class="steps">${stepsHtml}</div>

<div class="status-banner">
  <div class="status-dot running" id="status-dot"></div>
  <span id="status-text">Starting…</span>
</div>

<div class="browser-hint" id="browser-hint">
  ⚡ A browser window has opened for OAuth authorization. Complete the login there, then return here.
</div>

<div class="terminal">
  <div class="terminal-header">
    <span class="dot dot-red"></span>
    <span class="dot dot-yellow"></span>
    <span class="dot dot-green"></span>
    <span class="terminal-title">dex adapter new-from-mcp ${adapterId}</span>
  </div>
  <div id="log"></div>
</div>

<div class="result-banner" id="result-banner">
  <span class="result-icon" id="result-icon"></span>
  <span id="result-text"></span>
</div>

<script>
  const vscode = acquireVsCodeApi();

  const STEP_ORDER = ['oauth-discover','dcr','oauth-auth','introspect','build'];
  let currentStepIdx = -1;

  const statusDot  = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const logEl      = document.getElementById('log');
  const resultBanner = document.getElementById('result-banner');
  const resultIcon = document.getElementById('result-icon');
  const resultText = document.getElementById('result-text');
  const browserHint = document.getElementById('browser-hint');

  const STATUS = {
    'oauth-discover': 'Discovering OAuth configuration…',
    'dcr':            'Registering OAuth client…',
    'oauth-auth':     'Browser opened — authorize the connection…',
    'introspect':     'Introspecting MCP server tools…',
    'build':          'Building adapter…',
  };

  function activateStep(stepId) {
    const idx = STEP_ORDER.indexOf(stepId);
    if (idx < 0) return;

    // Mark all previous steps done
    for (let i = 0; i < idx; i++) {
      const el = document.getElementById('step-' + STEP_ORDER[i]);
      const icon = document.getElementById('icon-' + STEP_ORDER[i]);
      if (el) { el.className = 'step done'; }
      if (icon) { icon.innerHTML = '✓'; }
    }
    // Activate current
    const el  = document.getElementById('step-' + stepId);
    const icon = document.getElementById('icon-' + stepId);
    if (el)   { el.className = 'step active'; }
    if (icon) { icon.innerHTML = '<span class="step-num">' + (idx+1) + '</span>'; }

    currentStepIdx = idx;
    statusText.textContent = STATUS[stepId] || stepId;

    if (stepId === 'oauth-auth') {
      browserHint.classList.add('visible');
    } else {
      browserHint.classList.remove('visible');
    }
  }

  function markAllDone() {
    STEP_ORDER.forEach((sid, i) => {
      const el = document.getElementById('step-' + sid);
      const icon = document.getElementById('icon-' + sid);
      if (el)   { el.className = 'step done'; }
      if (icon) { icon.innerHTML = '✓'; }
    });
  }

  function appendLog(text, cls) {
    const p = document.createElement('p');
    p.className = 'log-line' + (cls ? ' ' + cls : '');
    // Colour key words
    p.textContent = text;
    logEl.appendChild(p);
    logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
  }

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'step') {
      activateStep(msg.step);
    } else if (msg.type === 'log') {
      const cls = msg.isError ? 'err' : (msg.text.includes('✓') || msg.text.includes('success') ? 'ok' : 'dim');
      appendLog(msg.text, cls);
    } else if (msg.type === 'success') {
      markAllDone();
      statusDot.className = 'status-dot success';
      statusText.textContent = 'Adapter connected successfully!';
      browserHint.classList.remove('visible');
      resultBanner.className = 'result-banner success';
      resultIcon.textContent = '✓';
      resultText.textContent = 'Adapter is ready. Refresh the adapter list to see it.';
    } else if (msg.type === 'failed') {
      statusDot.className = 'status-dot error';
      statusText.textContent = 'Connection failed (exit ' + (msg.code ?? '?') + ')';
      browserHint.classList.remove('visible');
      // Mark active step as error
      if (currentStepIdx >= 0) {
        const sid = STEP_ORDER[currentStepIdx];
        const el = document.getElementById('step-' + sid);
        if (el) { el.className = 'step error'; }
      }
      resultBanner.className = 'result-banner error';
      resultIcon.textContent = '✗';
      resultText.textContent = msg.message || 'Check the log above for details.';
    }
  });
</script>
</body>
</html>`;
}
