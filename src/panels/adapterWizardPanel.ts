import * as vscode from "vscode";
import type { DexClient } from "../client/dexClient";

interface CatalogInfo {
  [key: string]: string;
}

/**
 * Show the adapter creation wizard panel.
 *
 * Flow: Analyzing → Review → Toolsets → Create → Result
 * Uses `dex adapter new --dry-run` to detect spec, toolsets, and auth,
 * then presents results for user review before creating the adapter.
 */
export function showAdapterWizardPanel(
  extensionUri: vscode.Uri,
  client: DexClient,
  adapterId: string,
  catalogInfo: CatalogInfo,
  onCreated: () => void
): void {
  const panel = vscode.window.createWebviewPanel(
    "modiqo.adapterWizard",
    `Install: ${catalogInfo["Provider"] || adapterId}`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const specUrl = catalogInfo["Spec URL"] || "";

  panel.webview.html = buildWizardHtml(adapterId, catalogInfo);

  // Start dry-run analysis immediately
  runDryRun(panel, client, adapterId, specUrl);

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === "create") {
      await handleCreate(panel, client, adapterId, specUrl, msg.config, onCreated);
    } else if (msg.type === "cancel") {
      panel.dispose();
    } else if (msg.type === "retry-analyze") {
      const baseUrl = msg.baseUrl || "";
      runDryRun(panel, client, adapterId, specUrl, baseUrl);
    }
  });
}

// ── Dry-run analysis ───────────────────────────────────────────

async function runDryRun(
  panel: vscode.WebviewPanel,
  client: DexClient,
  adapterId: string,
  specUrl: string,
  baseUrlOverride?: string
): Promise<void> {
  try {
    const opts = baseUrlOverride ? { baseUrl: baseUrlOverride } : undefined;
    const result = await client.adapterDryRun(adapterId, specUrl, opts);
    panel.webview.postMessage({ type: "dry-run-done", result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    panel.webview.postMessage({ type: "dry-run-error", message: msg });
  }
}

// ── Create handler ──────────────────────────────────────────────

interface CreateConfig {
  baseUrl: string;
  group: string;
  configJson?: {
    auth?: Record<string, unknown>;
    additional_headers?: Record<string, string>;
    toolset_filters?: Record<string, string>;
    enable_parameter_cleaning?: boolean;
  };
}

async function handleCreate(
  panel: vscode.WebviewPanel,
  client: DexClient,
  adapterId: string,
  specUrl: string,
  config: CreateConfig,
  onCreated: () => void
): Promise<void> {
  panel.webview.postMessage({ type: "creating", message: "Starting adapter creation..." });

  const options: { baseUrl?: string; group?: string; configJson?: object } = {};
  if (config.baseUrl) { options.baseUrl = config.baseUrl; }
  if (config.group) { options.group = config.group; }
  if (config.configJson) { options.configJson = config.configJson; }

  const child = client.adapterCreateStream(adapterId, specUrl, options);

  let output = "";
  const lines: string[] = [];

  const processLine = (line: string) => {
    /* eslint-disable no-control-regex */
    const clean = line
      .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "")
      .replace(/[\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F\u2714\u2713]/g, "")
      .replace(/\[K/g, "")
      .trim();
    /* eslint-enable no-control-regex */
    if (clean.length > 0 && !lines.includes(clean)) {
      lines.push(clean);
      panel.webview.postMessage({ type: "progress", message: clean });
    }
  };

  child.stdout?.on("data", (data: Buffer) => {
    output += data.toString();
    for (const line of data.toString().split("\n")) { processLine(line); }
  });

  child.stderr?.on("data", (data: Buffer) => {
    output += data.toString();
    for (const line of data.toString().split("\n")) { processLine(line); }
  });

  child.on("close", (code) => {
    if (code === 0) {
      const result = parseCreationResult(output, adapterId);
      panel.webview.postMessage({ type: "done", result });
      onCreated();
      vscode.window.showInformationMessage(
        `Adapter "${adapterId}" created with ${result.tools} tools.`
      );
    } else {
      const errorMsg = extractError(output) || `Adapter creation failed (exit code ${code})`;
      panel.webview.postMessage({ type: "error", message: errorMsg });
    }
  });

  child.on("error", (err) => {
    panel.webview.postMessage({ type: "error", message: err.message });
  });
}

// ── Output parsers ──────────────────────────────────────────────

function parseCreationResult(
  output: string,
  adapterId: string
): { id: string; tools: string; toolsets: string; specType: string } {
  let tools = "0";
  let toolsets = "0";
  let specType = "";

  for (const line of output.split("\n")) {
    // eslint-disable-next-line no-control-regex
    const clean = line.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "").trim();
    const filesMatch = clean.match(/(\d+)\s+toolsets?,\s+(\d+)\s+tools/);
    if (filesMatch) { toolsets = filesMatch[1]; tools = filesMatch[2]; }
    const parsedMatch = clean.match(/Parsed\s+.+?\s+(\d+)\s+operations/);
    if (parsedMatch && tools === "0") { tools = parsedMatch[1]; }
    if (clean.includes("openapi") || clean.includes("OAS")) { specType = "openapi3"; }
    else if (clean.includes("graphql")) { specType = "graphql"; }
    else if (clean.includes("discovery")) { specType = "discovery"; }
  }

  return { id: adapterId, tools, toolsets, specType };
}

function extractError(output: string): string {
  for (const line of output.split("\n").reverse()) {
    // eslint-disable-next-line no-control-regex
    const clean = line.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "").trim();
    if (clean.startsWith("Error:") || clean.startsWith("error:")) { return clean; }
    if (clean.includes("already exists")) {
      return "Adapter already exists. Remove it first with: dex adapter remove";
    }
  }
  return "";
}

// ── Webview HTML ────────────────────────────────────────────────

function buildWizardHtml(adapterId: string, info: CatalogInfo): string {
  const provider = esc(info["Provider"] || adapterId);
  const category = esc(info["Category"] || "");
  const firstParty = info["First-party"] === "Yes";
  const tokenPage = info["Token Page"] || "";

  const badge = firstParty
    ? `<span class="badge first-party">first-party</span>`
    : `<span class="badge community">community</span>`;

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
    --accent: var(--vscode-textLink-foreground);
    --badge-bg: var(--vscode-badge-background);
    --badge-fg: var(--vscode-badge-foreground);
    --card-bg: var(--vscode-editorWidget-background, var(--bg));
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, var(--border));
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
    --btn-secondary-bg: var(--vscode-button-secondaryBackground);
    --btn-secondary-fg: var(--vscode-button-secondaryForeground);
    --success: var(--vscode-testing-iconPassed, #4caf50);
    --error: var(--vscode-errorForeground, #f44336);
    --warn: var(--vscode-editorWarning-foreground, #ffa500);
  }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--fg);
    background: var(--bg);
    margin: 0;
    padding: 24px 36px;
    line-height: 1.6;
  }

  .header { margin-bottom: 20px; }
  .header h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 4px 0; }
  .header .subtitle { color: var(--fg-dim); font-size: 0.88em; }

  .badge {
    display: inline-block; font-size: 0.72em; padding: 2px 8px;
    border-radius: 3px; margin-left: 8px; vertical-align: middle; font-weight: 500;
  }
  .badge.first-party { background: var(--badge-bg); color: var(--badge-fg); }
  .badge.community { border: 1px solid var(--border); color: var(--fg-dim); }

  .step-indicator {
    display: flex; gap: 6px; margin-bottom: 20px; font-size: 0.78em; color: var(--fg-dim);
    flex-wrap: wrap;
  }
  .step-indicator .step {
    padding: 3px 10px; border-radius: 3px; border: 1px solid var(--border);
  }
  .step-indicator .step.active {
    background: var(--btn-bg); color: var(--btn-fg); border-color: var(--btn-bg);
  }
  .step-indicator .step.done { border-color: var(--success); color: var(--success); }

  .card {
    background: var(--card-bg); border: 1px solid var(--border);
    border-radius: 6px; padding: 16px 20px; margin-bottom: 14px;
  }
  .card h2 {
    font-size: 0.78em; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--fg-dim); margin: 0 0 12px 0;
  }

  .row {
    display: flex; padding: 4px 0; border-bottom: 1px solid var(--border);
    align-items: center;
  }
  .row:last-child { border-bottom: none; }
  .row .label { width: 140px; flex-shrink: 0; color: var(--fg-dim); font-size: 0.86em; }
  .row .value { flex: 1; font-size: 0.86em; word-break: break-all; }
  .row .value a { color: var(--accent); text-decoration: none; }

  .form-group { margin-bottom: 12px; }
  .form-group label {
    display: block; font-size: 0.82em; color: var(--fg-dim);
    margin-bottom: 4px; font-weight: 500;
  }
  .form-group input, .form-group select {
    width: 100%; padding: 6px 10px; background: var(--input-bg);
    color: var(--input-fg); border: 1px solid var(--input-border);
    border-radius: 4px; font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size); box-sizing: border-box;
  }
  .form-group .hint { font-size: 0.76em; color: var(--fg-dim); margin-top: 3px; }

  .btn-row { display: flex; gap: 10px; margin-top: 16px; }
  .btn {
    padding: 7px 18px; border: none; border-radius: 4px;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    cursor: pointer; font-weight: 500;
  }
  .btn-primary { background: var(--btn-bg); color: var(--btn-fg); }
  .btn-primary:hover { background: var(--btn-hover); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-secondary { background: var(--btn-secondary-bg); color: var(--btn-secondary-fg); }

  .spinner {
    display: inline-block; width: 28px; height: 28px;
    border: 3px solid var(--border); border-top-color: var(--accent);
    border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 12px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .progress-section { text-align: center; padding: 32px 0; }

  .log-lines {
    text-align: left; font-family: var(--vscode-editor-font-family);
    font-size: 0.83em; color: var(--fg-dim); margin-top: 14px;
    max-height: 180px; overflow-y: auto; line-height: 1.7;
  }
  .log-lines .line { padding: 2px 0; border-bottom: 1px solid var(--border); }
  .log-lines .line:last-child { border-bottom: none; }

  .result-icon { font-size: 2.2em; margin-bottom: 10px; }
  .result-success { color: var(--success); }
  .result-error { color: var(--error); }

  .screen { display: none; }
  .screen.active { display: block; }

  /* Toolset table */
  .toolset-table { width: 100%; border-collapse: collapse; font-size: 0.86em; }
  .toolset-table th {
    text-align: left; padding: 6px 8px; border-bottom: 2px solid var(--border);
    color: var(--fg-dim); font-weight: 600; font-size: 0.82em;
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  .toolset-table td { padding: 5px 8px; border-bottom: 1px solid var(--border); }
  .toolset-table tr:last-child td { border-bottom: none; }
  .toolset-table input[type="checkbox"] { margin: 0; cursor: pointer; }
  .toolset-table .method-badge {
    display: inline-block; padding: 1px 6px; border-radius: 3px;
    font-size: 0.78em; font-weight: 500; margin-right: 3px;
  }
  .method-get { background: #1a3a2a; color: #4caf50; }
  .method-post { background: #2a2a1a; color: #ffc107; }
  .method-put { background: #1a2a3a; color: #2196f3; }
  .method-delete { background: #3a1a1a; color: #f44336; }
  .method-patch { background: #2a1a3a; color: #ab47bc; }

  .select-actions { margin-bottom: 8px; font-size: 0.82em; }
  .select-actions a {
    color: var(--accent); cursor: pointer; text-decoration: none; margin-right: 12px;
  }
  .select-actions a:hover { text-decoration: underline; }

  .stat-pill {
    display: inline-block; padding: 2px 10px; border-radius: 12px;
    font-size: 0.82em; margin-right: 6px; border: 1px solid var(--border);
    color: var(--fg-dim);
  }

  .auth-type-label {
    display: inline-block; padding: 2px 10px; border-radius: 3px;
    font-size: 0.82em; font-weight: 500;
    background: var(--badge-bg); color: var(--badge-fg);
  }

  .token-link { margin-top: 10px; font-size: 0.86em; }
  .token-link a { color: var(--accent); text-decoration: none; }
  .token-link a:hover { text-decoration: underline; }

  .toolset-table select {
    font-family: var(--vscode-font-family);
  }

  /* Multi-auth scheme table */
  .scheme-row {
    display: flex; align-items: flex-start; gap: 12px; padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }
  .scheme-row:last-child { border-bottom: none; }
  .scheme-row .scheme-check { flex-shrink: 0; margin-top: 3px; }
  .scheme-row .scheme-info { flex: 1; }
  .scheme-row .scheme-name { font-weight: 600; font-size: 0.9em; }
  .scheme-row .scheme-meta {
    font-size: 0.82em; color: var(--fg-dim); margin-top: 2px;
  }
  .scheme-row .scheme-env {
    margin-top: 6px;
  }
  .scheme-row .scheme-env input {
    width: 280px; padding: 4px 8px; background: var(--input-bg);
    color: var(--input-fg); border: 1px solid var(--input-border);
    border-radius: 3px; font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  .scheme-row .scheme-env label {
    font-size: 0.78em; color: var(--fg-dim); margin-right: 6px;
  }
</style>
</head>
<body>
  <div class="header">
    <h1>${provider} ${badge}</h1>
    <div class="subtitle">${category} &mdash; ${esc(adapterId)}</div>
  </div>

  <div class="step-indicator">
    <div class="step active" id="si-1">1. Analyze</div>
    <div class="step" id="si-2">2. Review</div>
    <div class="step" id="si-3">3. Auth</div>
    <div class="step" id="si-4">4. Toolsets</div>
    <div class="step" id="si-5">5. Configure</div>
    <div class="step" id="si-6">6. Install</div>
  </div>

  <!-- Screen 1: Analyzing (dry-run) -->
  <div class="screen active" id="screen-analyze">
    <div class="progress-section">
      <div class="spinner"></div>
      <div>Analyzing API specification...</div>
      <div style="color:var(--fg-dim);font-size:0.85em;margin-top:8px">
        Downloading, parsing, detecting toolsets and authentication
      </div>
    </div>
  </div>

  <!-- Screen 1b: Analyze error -->
  <div class="screen" id="screen-analyze-error">
    <div class="card">
      <h2>Analysis Failed</h2>
      <div id="analyzeErrorMsg" style="color:var(--error);margin-bottom:12px"></div>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="retryAnalyze()">Retry</button>
        <button class="btn btn-secondary" onclick="doCancel()">Cancel</button>
      </div>
    </div>
  </div>

  <!-- Screen 2: Review detection -->
  <div class="screen" id="screen-review">
    <div class="card">
      <h2>Specification</h2>
      <div class="row"><div class="label">Title</div><div class="value" id="rv-title"></div></div>
      <div class="row"><div class="label">Version</div><div class="value" id="rv-version"></div></div>
      <div class="row"><div class="label">OpenAPI</div><div class="value" id="rv-openapi"></div></div>
      <div class="row"><div class="label">Base URL</div><div class="value" id="rv-baseurl"></div></div>
      <div class="row"><div class="label">Operations</div><div class="value" id="rv-ops"></div></div>
      <div class="row"><div class="label">Spec Size</div><div class="value" id="rv-size"></div></div>
    </div>

    <div class="card">
      <h2>Authentication</h2>
      <div id="rv-auth"></div>
    </div>

    <div class="card">
      <h2>Detection Summary</h2>
      <div id="rv-summary"></div>
    </div>

    <div class="card">
      <h2>Base URL Override (optional)</h2>
      <div class="form-group">
        <input type="text" id="rv-baseurl-override" placeholder="Leave empty to use detected URL" />
        <div class="hint">Override if the detected base URL is incorrect</div>
      </div>
    </div>

    <div class="btn-row">
      <button class="btn btn-primary" onclick="goToAuth()">Next: Authentication</button>
      <button class="btn btn-secondary" onclick="doCancel()">Cancel</button>
    </div>
  </div>

  <!-- Screen 3: Authentication (single-scheme mode) -->
  <div class="screen" id="screen-auth">
    <div class="card">
      <h2>Authentication</h2>
      <div style="font-size:0.86em;color:var(--fg-dim);margin-bottom:12px">
        Configure how this adapter authenticates with the API.
      </div>

      <div class="form-group">
        <label for="auth-type">Auth Type</label>
        <select id="auth-type" onchange="onAuthTypeChange()">
          <option value="api_key_header">API Key (Header)</option>
          <option value="bearer">Bearer Token</option>
          <option value="basic">Basic Authentication</option>
          <option value="none">None</option>
        </select>
      </div>

      <div id="auth-header-group" class="form-group">
        <label for="auth-header">API Key Header Name</label>
        <select id="auth-header" onchange="onAuthHeaderChange()">
          <option value="Authorization">Authorization</option>
          <option value="API-Key">API-Key</option>
          <option value="ApiKey">ApiKey</option>
          <option value="X-API-Key">X-API-Key</option>
          <option value="X-RapidAPI-Key">X-RapidAPI-Key</option>
          <option value="X-Auth-Token">X-Auth-Token</option>
          <option value="__custom__">Custom (enter your own)</option>
        </select>
      </div>

      <div id="auth-header-custom-group" class="form-group" style="display:none">
        <label for="auth-header-custom">Custom Header Name</label>
        <input type="text" id="auth-header-custom" placeholder="e.g. X-My-Api-Key" />
      </div>

      <div id="auth-env-group" class="form-group">
        <label for="auth-env">Environment Variable</label>
        <input type="text" id="auth-env" placeholder="e.g. MY_API_KEY" />
        <div class="hint">The env variable name for storing the token/key</div>
      </div>
    </div>

    <div class="btn-row">
      <button class="btn btn-secondary" onclick="goToReview()">Back</button>
      <button class="btn btn-primary" onclick="goToToolsets()">Next: Select Toolsets</button>
    </div>
  </div>

  <!-- Screen 3b: Authentication (multi-scheme / per-operation mode) -->
  <div class="screen" id="screen-auth-multi">
    <div class="card">
      <h2>Security Schemes</h2>
      <div style="font-size:0.86em;color:var(--fg-dim);margin-bottom:12px">
        This API supports multiple authentication schemes. Select which ones to configure.
      </div>
      <div id="multi-auth-schemes"></div>
    </div>

    <div class="card">
      <h2>Default Scheme</h2>
      <div style="font-size:0.86em;color:var(--fg-dim);margin-bottom:10px">
        Scheme to use for operations without explicit security annotations.
      </div>
      <div class="form-group">
        <select id="default-scheme">
          <option value="">(None &mdash; unannotated operations get no auth)</option>
        </select>
      </div>
    </div>

    <div class="btn-row">
      <button class="btn btn-secondary" onclick="goToReview()">Back</button>
      <button class="btn btn-primary" onclick="goToToolsets()">Next: Select Toolsets</button>
    </div>
  </div>

  <!-- Screen 4: Toolset selection -->
  <div class="screen" id="screen-toolsets">
    <div class="card">
      <h2>Select Toolsets</h2>
      <div class="select-actions">
        <a onclick="selectAll()">Select All</a>
        <a onclick="selectNone()">Select None</a>
        <a onclick="selectReadOnly()">Read-only Only</a>
        &nbsp;|&nbsp;
        <a onclick="setAllAccessLevel('all')">All R+W</a>
        <a onclick="setAllAccessLevel('read-only')">All Read-only</a>
        <a onclick="setAllAccessLevel('write-only')">All Write-only</a>
      </div>
      <div id="toolset-table-container"></div>
    </div>

    <div id="toolset-selection-summary" style="margin-bottom:14px;font-size:0.86em;color:var(--fg-dim)"></div>

    <div class="btn-row">
      <button class="btn btn-secondary" onclick="goToAuth()">Back</button>
      <button class="btn btn-primary" onclick="goToConfigure()">Next: Configure</button>
    </div>
  </div>

  <!-- Screen 5: Configure -->
  <div class="screen" id="screen-configure">
    <div class="card">
      <h2>Adapter Configuration</h2>
      <div class="form-group">
        <label for="cfg-group">Group (optional)</label>
        <input type="text" id="cfg-group" placeholder="e.g. gsuite, workday, ai" />
        <div class="hint">Group related adapters together for organized display</div>
      </div>
    </div>

    <div class="card">
      <h2>Additional Headers (optional)</h2>
      <div style="font-size:0.86em;color:var(--fg-dim);margin-bottom:10px">
        Add custom HTTP headers sent with every API request.
      </div>
      <div id="headers-container"></div>
      <button class="btn btn-secondary" style="margin-top:8px;font-size:0.82em;padding:4px 12px" onclick="addHeaderRow()">+ Add Header</button>
    </div>

    <div class="card">
      <h2>Parameter Cleaning</h2>
      <div class="form-group">
        <label style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="cfg-param-cleaning" checked style="width:auto" />
          Enable automatic parameter cleaning
        </label>
        <div class="hint">Removes null/undefined parameters from API requests</div>
      </div>
    </div>

    ${tokenPage ? `
    <div class="card">
      <h2>Token Page</h2>
      <div class="token-link">
        Get your API token: <a href="${esc(tokenPage)}">${esc(tokenPage)}</a>
      </div>
    </div>` : ""}

    <div class="btn-row">
      <button class="btn btn-secondary" onclick="goToToolsets()">Back</button>
      <button class="btn btn-primary" id="createBtn" onclick="doCreate()">Create Adapter</button>
    </div>
  </div>

  <!-- Screen 5: Creating -->
  <div class="screen" id="screen-creating">
    <div class="progress-section">
      <div class="spinner"></div>
      <div id="progressMsg">Initializing...</div>
    </div>
    <div class="log-lines" id="logLines"></div>
  </div>

  <!-- Screen 6: Result -->
  <div class="screen" id="screen-result">
    <div id="resultContent"></div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let dryRunData = null;
    const STEPS = ['si-1','si-2','si-3','si-4','si-5','si-6'];
    const SCREENS = ['analyze','review','auth','auth-multi','toolsets','configure','creating','result'];

    function showScreen(name, stepIdx) {
      SCREENS.forEach(s => {
        const el = document.getElementById('screen-' + s);
        if (el) el.classList.remove('active');
      });
      // Also hide error screen
      const errScreen = document.getElementById('screen-analyze-error');
      if (errScreen) errScreen.classList.remove('active');

      const target = document.getElementById('screen-' + name);
      if (target) target.classList.add('active');

      if (stepIdx !== undefined) {
        STEPS.forEach((s, i) => {
          const el = document.getElementById(s);
          el.classList.remove('active', 'done');
          if (i < stepIdx) el.classList.add('done');
          else if (i === stepIdx) el.classList.add('active');
        });
      }
    }

    function retryAnalyze() {
      showScreen('analyze', 0);
      const baseUrl = document.getElementById('rv-baseurl-override')?.value?.trim() || '';
      vscode.postMessage({ type: 'retry-analyze', baseUrl });
    }

    function populateReview(data) {
      dryRunData = data;
      const spec = data.spec;

      document.getElementById('rv-title').textContent = spec.title;
      document.getElementById('rv-version').textContent = spec.version;
      document.getElementById('rv-openapi').textContent = spec.openapi_version;
      document.getElementById('rv-baseurl').textContent = spec.base_url || '(not detected)';
      document.getElementById('rv-ops').textContent = spec.operation_count + ' operations';
      document.getElementById('rv-size').textContent = formatBytes(spec.spec_size_bytes);

      // Auth
      const authEl = document.getElementById('rv-auth');
      const authType = data.auth.type || 'none';

      if (authType === 'per_operation' && data.auth.schemes) {
        const schemeNames = Object.keys(data.auth.schemes);
        let authHtml = '<div class="row"><div class="label">Mode</div><div class="value"><span class="auth-type-label">per-operation</span> &mdash; ' + schemeNames.length + ' schemes detected</div></div>';
        for (const [name, cfg] of Object.entries(data.auth.schemes)) {
          const schemeDef = (data.auth.spec_security_schemes || {})[name] || {};
          const typeLabel = cfg.type === 'bearer' ? 'Bearer' :
            cfg.type === 'api_key_header' ? 'API Key (' + (cfg.header_name || schemeDef.name || '') + ')' :
            cfg.type === 'basic' ? 'Basic' : cfg.type;
          const envLabel = cfg.key_env || cfg.token_env || cfg.username_env || '';
          const ops = schemeDef.name ? schemeDef.name : '';
          authHtml += '<div class="row"><div class="label">' + escHtml(name) + '</div><div class="value">' + escHtml(typeLabel) + (envLabel ? ' &rarr; <code>$' + escHtml(envLabel) + '</code>' : '') + '</div></div>';
        }
        if (data.auth.default_scheme) {
          authHtml += '<div class="row"><div class="label">Default</div><div class="value"><strong>' + escHtml(data.auth.default_scheme) + '</strong> (for unannotated operations)</div></div>';
        }
        authEl.innerHTML = authHtml;
      } else {
        let authHtml = '<div class="row"><div class="label">Type</div><div class="value"><span class="auth-type-label">' + escHtml(authType) + '</span></div></div>';
        if (data.auth.header_name) {
          authHtml += '<div class="row"><div class="label">Header</div><div class="value"><code>' + escHtml(data.auth.header_name) + '</code></div></div>';
        }
        if (data.auth.key_env || data.auth.token_env) {
          authHtml += '<div class="row"><div class="label">Env Variable</div><div class="value"><code>' + escHtml(data.auth.key_env || data.auth.token_env) + '</code></div></div>';
        }
        authEl.innerHTML = authHtml;
      }

      // Summary
      const s = data.summary;
      const summaryEl = document.getElementById('rv-summary');
      summaryEl.innerHTML =
        '<span class="stat-pill">' + s.total_toolsets + ' toolsets</span>' +
        '<span class="stat-pill">' + s.total_tools + ' tools</span>' +
        '<span class="stat-pill">GET: ' + s.get_operations + '</span>' +
        '<span class="stat-pill">POST: ' + s.post_operations + '</span>' +
        '<span class="stat-pill">PUT: ' + s.put_operations + '</span>' +
        '<span class="stat-pill">DELETE: ' + s.delete_operations + '</span>' +
        '<div style="margin-top:8px;font-size:0.82em;color:var(--fg-dim)">Detection: ' + escHtml(data.detection_method) + '</div>';

      // Pre-fill base URL override
      if (spec.base_url) {
        document.getElementById('rv-baseurl-override').placeholder = spec.base_url;
      }
    }

    // ── Auth helpers ──────────────────────────────────

    let isMultiAuth = false;

    function populateAuth(data) {
      const auth = data.auth || {};
      const authType = auth.type || 'none';

      if (authType === 'per_operation' && auth.schemes) {
        isMultiAuth = true;
        populateMultiAuth(auth);
      } else {
        isMultiAuth = false;

        // Map dry-run auth type to select value
        const typeSelect = document.getElementById('auth-type');
        if (authType === 'bearer') typeSelect.value = 'bearer';
        else if (authType === 'api_key_header') typeSelect.value = 'api_key_header';
        else if (authType === 'basic') typeSelect.value = 'basic';
        else typeSelect.value = 'none';

        // Pre-fill header name
        if (auth.header_name) {
          const headerSelect = document.getElementById('auth-header');
          const match = Array.from(headerSelect.options).find(o => o.value === auth.header_name);
          if (match) {
            headerSelect.value = auth.header_name;
          } else {
            headerSelect.value = '__custom__';
            document.getElementById('auth-header-custom').value = auth.header_name;
            document.getElementById('auth-header-custom-group').style.display = 'block';
          }
        }

        // Pre-fill env var
        const envVar = auth.key_env || auth.token_env || '';
        if (envVar) document.getElementById('auth-env').value = envVar;

        onAuthTypeChange();
      }
    }

    function populateMultiAuth(auth) {
      const container = document.getElementById('multi-auth-schemes');
      const specSchemes = auth.spec_security_schemes || {};
      let html = '';

      for (const [name, cfg] of Object.entries(auth.schemes)) {
        const schemeDef = specSchemes[name] || {};
        const typeLabel = cfg.type === 'bearer' ? 'http/bearer' :
          cfg.type === 'api_key_header' ? 'apiKey/header' :
          cfg.type === 'api_key_query' ? 'apiKey/query' :
          cfg.type === 'basic' ? 'http/basic' : cfg.type;
        const headerLabel = schemeDef.name || cfg.header_name || (cfg.type === 'bearer' ? 'Authorization' : '');
        const envVar = cfg.key_env || cfg.token_env || cfg.username_env || '';

        html += '<div class="scheme-row">' +
          '<div class="scheme-check"><input type="checkbox" checked data-scheme="' + escHtml(name) + '" onchange="onMultiAuthChange()" /></div>' +
          '<div class="scheme-info">' +
            '<div class="scheme-name">' + escHtml(name) + '</div>' +
            '<div class="scheme-meta">' + escHtml(typeLabel) + (headerLabel ? ' &mdash; <code>' + escHtml(headerLabel) + '</code>' : '') + '</div>' +
            '<div class="scheme-env">' +
              '<label>Env variable:</label>' +
              '<input type="text" value="' + escHtml(envVar) + '" data-scheme-env="' + escHtml(name) + '" />' +
            '</div>' +
          '</div>' +
          '</div>';
      }

      container.innerHTML = html;

      // Populate default scheme dropdown
      const defaultSelect = document.getElementById('default-scheme');
      defaultSelect.innerHTML = '<option value="">(None — unannotated operations get no auth)</option>';
      for (const name of Object.keys(auth.schemes)) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        if (auth.default_scheme === name) opt.selected = true;
        defaultSelect.appendChild(opt);
      }

      onMultiAuthChange();
    }

    function onMultiAuthChange() {
      // Disable env inputs for unchecked schemes
      document.querySelectorAll('[data-scheme]').forEach(cb => {
        const name = cb.dataset.scheme;
        const envInput = document.querySelector('[data-scheme-env="' + name + '"]');
        if (envInput) {
          envInput.disabled = !cb.checked;
          envInput.style.opacity = cb.checked ? '1' : '0.4';
        }
      });

      // Update default scheme dropdown to only show checked schemes
      const defaultSelect = document.getElementById('default-scheme');
      const currentDefault = defaultSelect.value;
      defaultSelect.innerHTML = '<option value="">(None — unannotated operations get no auth)</option>';
      document.querySelectorAll('[data-scheme]:checked').forEach(cb => {
        const name = cb.dataset.scheme;
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        if (name === currentDefault) opt.selected = true;
        defaultSelect.appendChild(opt);
      });
    }

    function getMultiAuthConfig() {
      const schemes = {};
      const specSchemes = dryRunData.auth.spec_security_schemes || {};

      document.querySelectorAll('[data-scheme]:checked').forEach(cb => {
        const name = cb.dataset.scheme;
        const envInput = document.querySelector('[data-scheme-env="' + name + '"]');
        const envVar = envInput ? envInput.value.trim() : '';
        if (!envVar) return;

        const origCfg = dryRunData.auth.schemes[name] || {};
        if (origCfg.type === 'bearer') {
          schemes[name] = { type: 'bearer', token_env: envVar };
        } else if (origCfg.type === 'api_key_header') {
          schemes[name] = { type: 'api_key_header', header_name: origCfg.header_name, key_env: envVar };
        } else if (origCfg.type === 'api_key_query') {
          schemes[name] = { type: 'api_key_query', param_name: origCfg.param_name, key_env: envVar };
        } else if (origCfg.type === 'basic') {
          schemes[name] = { type: 'basic', username_env: envVar, password_env: envVar + '_PASSWORD' };
        }
      });

      if (Object.keys(schemes).length === 0) return null;

      const defaultScheme = document.getElementById('default-scheme').value || null;

      return {
        type: 'per_operation',
        schemes,
        default_scheme: defaultScheme,
        spec_security_schemes: dryRunData.auth.spec_security_schemes || undefined
      };
    }

    function onAuthTypeChange() {
      const authType = document.getElementById('auth-type').value;
      const headerGroup = document.getElementById('auth-header-group');
      const customGroup = document.getElementById('auth-header-custom-group');
      const envGroup = document.getElementById('auth-env-group');

      headerGroup.style.display = authType === 'api_key_header' ? 'block' : 'none';
      customGroup.style.display = 'none';
      envGroup.style.display = authType === 'none' ? 'none' : 'block';

      if (authType === 'api_key_header') onAuthHeaderChange();
    }

    function onAuthHeaderChange() {
      const val = document.getElementById('auth-header').value;
      document.getElementById('auth-header-custom-group').style.display =
        val === '__custom__' ? 'block' : 'none';
    }

    function getAuthConfig() {
      const authType = document.getElementById('auth-type').value;
      if (authType === 'none') return null;

      const env = document.getElementById('auth-env').value.trim();
      if (!env) return null;

      if (authType === 'bearer') {
        return { type: 'bearer', token_env: env };
      }
      if (authType === 'api_key_header') {
        let headerName = document.getElementById('auth-header').value;
        if (headerName === '__custom__') {
          headerName = document.getElementById('auth-header-custom').value.trim() || 'Authorization';
        }
        return { type: 'api_key_header', header_name: headerName, key_env: env };
      }
      if (authType === 'basic') {
        return { type: 'basic', username_env: env, password_env: env + '_PASSWORD' };
      }
      return null;
    }

    // ── Toolset helpers ──────────────────────────────

    function populateToolsets() {
      if (!dryRunData) return;
      const container = document.getElementById('toolset-table-container');
      const toolsets = dryRunData.toolsets;

      let html = '<table class="toolset-table">';
      html += '<tr><th style="width:30px"></th><th>Toolset</th><th>Tools</th><th>Methods</th><th>Access Level</th></tr>';

      toolsets.forEach((t, i) => {
        const methods = t.methods || {};
        const readCount = methods['GET'] || 0;
        const writeCount = t.tool_count - readCount;
        let methodBadges = '';
        for (const [m, count] of Object.entries(methods)) {
          const cls = 'method-' + m.toLowerCase();
          methodBadges += '<span class="method-badge ' + cls + '">' + m + ':' + count + '</span>';
        }

        // Determine sensible default: if all read → read-only, if all write → write-only
        const hasRead = readCount > 0;
        const hasWrite = writeCount > 0;
        let defaultAccess = 'all';
        if (hasRead && !hasWrite) defaultAccess = 'read-only';
        else if (!hasRead && hasWrite) defaultAccess = 'write-only';

        html += '<tr>' +
          '<td><input type="checkbox" checked data-idx="' + i + '" onchange="updateToolsetSummary()" /></td>' +
          '<td><strong>' + escHtml(t.name) + '</strong></td>' +
          '<td>' + t.tool_count + ' <span style="color:var(--fg-dim);font-size:0.82em">(' + readCount + 'r/' + writeCount + 'w)</span></td>' +
          '<td>' + methodBadges + '</td>' +
          '<td><select data-access-idx="' + i + '" style="padding:3px 6px;background:var(--input-bg);color:var(--input-fg);border:1px solid var(--input-border);border-radius:3px;font-size:0.9em" onchange="updateToolsetSummary()">' +
            '<option value="all"' + (defaultAccess === 'all' ? ' selected' : '') + '>All (r+w)</option>' +
            '<option value="read-only"' + (defaultAccess === 'read-only' ? ' selected' : '') + '>Read-only</option>' +
            '<option value="write-only"' + (defaultAccess === 'write-only' ? ' selected' : '') + '>Write-only</option>' +
          '</select></td>' +
          '</tr>';
      });

      html += '</table>';
      container.innerHTML = html;
      updateToolsetSummary();
    }

    function getSelectedToolsets() {
      const checkboxes = document.querySelectorAll('.toolset-table input[type="checkbox"]');
      const selected = [];
      checkboxes.forEach(cb => {
        if (cb.checked) selected.push(parseInt(cb.dataset.idx));
      });
      return selected;
    }

    function updateToolsetSummary() {
      const selected = getSelectedToolsets();
      const totalTools = selected.reduce((sum, idx) => sum + dryRunData.toolsets[idx].tool_count, 0);
      const el = document.getElementById('toolset-selection-summary');
      el.textContent = selected.length + ' of ' + dryRunData.toolsets.length + ' toolsets selected (' + totalTools + ' tools)';
    }

    function selectAll() {
      document.querySelectorAll('.toolset-table input[type="checkbox"]').forEach(cb => cb.checked = true);
      updateToolsetSummary();
    }

    function selectNone() {
      document.querySelectorAll('.toolset-table input[type="checkbox"]').forEach(cb => cb.checked = false);
      updateToolsetSummary();
    }

    function selectReadOnly() {
      if (!dryRunData) return;
      document.querySelectorAll('.toolset-table input[type="checkbox"]').forEach(cb => {
        const idx = parseInt(cb.dataset.idx);
        const t = dryRunData.toolsets[idx];
        const methods = Object.keys(t.methods || {});
        cb.checked = methods.every(m => m === 'GET');
      });
      updateToolsetSummary();
    }

    function setAllAccessLevel(level) {
      document.querySelectorAll('select[data-access-idx]').forEach(sel => sel.value = level);
      updateToolsetSummary();
    }

    function getToolsetFilters() {
      const selected = getSelectedToolsets();
      const filters = {};
      selected.forEach(idx => {
        const t = dryRunData.toolsets[idx];
        const sel = document.querySelector('select[data-access-idx="' + idx + '"]');
        const val = sel ? sel.value : 'all';
        filters[t.name] = val;
      });
      return filters;
    }

    // ── Additional headers ───────────────────────────

    let headerCount = 0;
    function addHeaderRow() {
      const container = document.getElementById('headers-container');
      const id = headerCount++;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;margin-bottom:6px;align-items:center';
      row.id = 'header-row-' + id;
      row.innerHTML =
        '<input type="text" placeholder="Header name" style="flex:1;padding:5px 8px;background:var(--input-bg);color:var(--input-fg);border:1px solid var(--input-border);border-radius:3px;font-size:0.9em" data-hdr-key="' + id + '" />' +
        '<input type="text" placeholder="Value" style="flex:1;padding:5px 8px;background:var(--input-bg);color:var(--input-fg);border:1px solid var(--input-border);border-radius:3px;font-size:0.9em" data-hdr-val="' + id + '" />' +
        '<button onclick="removeHeaderRow(' + id + ')" style="background:none;border:none;color:var(--error);cursor:pointer;font-size:1.1em;padding:2px 6px">&times;</button>';
      container.appendChild(row);
    }

    function removeHeaderRow(id) {
      const row = document.getElementById('header-row-' + id);
      if (row) row.remove();
    }

    function getAdditionalHeaders() {
      const headers = {};
      document.querySelectorAll('[data-hdr-key]').forEach(input => {
        const key = input.value.trim();
        const id = input.dataset.hdrKey;
        const valInput = document.querySelector('[data-hdr-val="' + id + '"]');
        const val = valInput ? valInput.value.trim() : '';
        if (key && val) headers[key] = val;
      });
      return headers;
    }

    // ── Navigation ───────────────────────────────────

    function goToReview() { showScreen('review', 1); }

    function goToAuth() {
      populateAuth(dryRunData);
      if (isMultiAuth) {
        showScreen('auth-multi', 2);
      } else {
        showScreen('auth', 2);
      }
    }

    function goToToolsets() {
      populateToolsets();
      showScreen('toolsets', 3);
    }

    function goToConfigure() {
      showScreen('configure', 4);
    }

    // ── Create ───────────────────────────────────────

    function doCreate() {
      const baseUrlOverride = document.getElementById('rv-baseurl-override')?.value?.trim() || '';
      const baseUrl = baseUrlOverride || (dryRunData?.spec?.base_url || '');
      const group = document.getElementById('cfg-group')?.value?.trim() || '';

      // Build configJson for --config-json flag
      const configJson = {};

      // Auth
      const authCfg = isMultiAuth ? getMultiAuthConfig() : getAuthConfig();
      if (authCfg) configJson.auth = authCfg;

      // Toolset filters
      const filters = getToolsetFilters();
      if (Object.keys(filters).length > 0) configJson.toolset_filters = filters;

      // Additional headers
      const headers = getAdditionalHeaders();
      if (Object.keys(headers).length > 0) configJson.additional_headers = headers;

      // Parameter cleaning
      const paramCleaning = document.getElementById('cfg-param-cleaning')?.checked;
      if (paramCleaning === false) configJson.enable_parameter_cleaning = false;

      document.getElementById('createBtn').disabled = true;
      vscode.postMessage({
        type: 'create',
        config: {
          baseUrl,
          group,
          configJson: Object.keys(configJson).length > 0 ? configJson : undefined
        }
      });
    }

    function doCancel() {
      vscode.postMessage({ type: 'cancel' });
    }

    function formatBytes(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function escHtml(s) {
      if (!s) return '';
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.type === 'dry-run-done') {
        populateReview(msg.result);
        showScreen('review', 1);
      }

      if (msg.type === 'dry-run-error') {
        document.getElementById('analyzeErrorMsg').textContent = msg.message;
        showScreen('analyze-error', 0);
      }

      if (msg.type === 'creating') {
        showScreen('creating', 5);
        document.getElementById('progressMsg').textContent = msg.message;
      }

      if (msg.type === 'progress') {
        document.getElementById('progressMsg').textContent = msg.message;
        const logEl = document.getElementById('logLines');
        const line = document.createElement('div');
        line.className = 'line';
        line.textContent = msg.message;
        logEl.appendChild(line);
        logEl.scrollTop = logEl.scrollHeight;
      }

      if (msg.type === 'done') {
        showScreen('result', 5);
        const r = msg.result;
        document.getElementById('resultContent').innerHTML =
          '<div style="text-align:center;padding:20px 0">' +
          '<div class="result-icon result-success">&#10003;</div>' +
          '<h2 style="margin:0 0 8px">Adapter Created</h2>' +
          '<p style="color:var(--fg-dim);margin:0 0 20px">Successfully installed <strong>' + escHtml(r.id) + '</strong></p>' +
          '</div>' +
          '<div class="card"><h2>Summary</h2>' +
          '<div class="row"><div class="label">Adapter ID</div><div class="value">' + escHtml(r.id) + '</div></div>' +
          '<div class="row"><div class="label">Tools</div><div class="value">' + escHtml(r.tools) + '</div></div>' +
          '<div class="row"><div class="label">Toolsets</div><div class="value">' + escHtml(r.toolsets) + '</div></div>' +
          '</div>' +
          '<div style="margin-top:16px;font-size:0.86em;color:var(--fg-dim)">' +
          'Configure authentication via the sidebar or run: <code>dex token set</code></div>';
      }

      if (msg.type === 'error') {
        showScreen('result', 5);
        document.getElementById('resultContent').innerHTML =
          '<div style="text-align:center;padding:20px 0">' +
          '<div class="result-icon result-error">&#10007;</div>' +
          '<h2 style="margin:0 0 8px">Creation Failed</h2>' +
          '<p style="color:var(--error);margin:0 0 20px">' + escHtml(msg.message) + '</p>' +
          '</div>' +
          '<div class="btn-row" style="justify-content:center">' +
          '<button class="btn btn-secondary" onclick="goToConfigure()">Try Again</button>' +
          '</div>';
      }
    });
  </script>
</body>
</html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
