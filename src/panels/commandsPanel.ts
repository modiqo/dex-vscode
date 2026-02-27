import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

interface WorkspaceInfo {
  name: string;
  dir: string;
}

interface CommandEntry {
  sequence: number;
  command: string;
  timestamp: string;
  responseIds: number[];
  params: Record<string, unknown>;
}

interface ResponsePair {
  id: string;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  status?: number;
  method?: string;
  toolName?: string;
}

export function showCommandsPanel(
  extensionUri: vscode.Uri,
  ws: WorkspaceInfo
): void {
  const stateFile = path.join(ws.dir, ".dex", "state.json");
  if (!fs.existsSync(stateFile)) {
    vscode.window.showWarningMessage("No state.json found.");
    return;
  }

  const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  const commands = parseCommands(state.command_log || []);
  const responses = loadResponses(ws.dir);

  const panel = vscode.window.createWebviewPanel(
    "modiqo.commands",
    `Commands: ${ws.name}`,
    vscode.ViewColumn.One,
    { enableScripts: true }
  );

  panel.webview.html = buildCommandsHtml(ws.name, commands, responses);
}

function parseCommands(
  log: Array<{
    sequence: number;
    type: { command: string; params: Record<string, unknown> };
    response_ids: number[];
    timestamp: string;
  }>
): CommandEntry[] {
  return log.map((e) => ({
    sequence: e.sequence,
    command: e.type.command,
    timestamp: e.timestamp,
    responseIds: e.response_ids,
    params: e.type.params,
  }));
}

function loadResponses(wsDir: string): ResponsePair[] {
  const responsesDir = path.join(wsDir, ".dex", "responses");
  if (!fs.existsSync(responsesDir)) { return []; }

  const files = fs.readdirSync(responsesDir)
    .filter((f) => f.startsWith("@") && f.endsWith(".json"))
    .sort((a, b) => {
      const na = parseInt(a.replace("@", "").replace(".json", ""), 10);
      const nb = parseInt(b.replace("@", "").replace(".json", ""), 10);
      return na - nb;
    });

  return files.map((f) => {
    const filePath = path.join(responsesDir, f);
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const rid = f.replace(".json", "");

    const reqBody = data.request?.body || {};
    const toolParams = reqBody.params as Record<string, unknown> | undefined;
    const toolName = (toolParams?.name as string) ??
      (reqBody.method as string) ?? "request";

    return {
      id: rid,
      request: data.request || {},
      response: data.response || {},
      status: data.response?.status,
      method: reqBody.method as string,
      toolName,
    };
  });
}

function buildCommandsHtml(
  wsName: string,
  commands: CommandEntry[],
  responses: ResponsePair[]
): string {
  const commandsJson = JSON.stringify(commands);
  const responsesJson = JSON.stringify(responses);

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
    --card-bg: var(--vscode-editorWidget-background, var(--bg));
    --success: #4ec9b0;
    --error: #f14c4c;
    --mono: var(--vscode-editor-font-family, 'SF Mono', 'Fira Code', monospace);
    --highlight: var(--vscode-editor-selectionBackground, rgba(100,150,255,0.15));
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--fg);
    background: var(--bg);
    line-height: 1.5;
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  .header {
    padding: 16px 24px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .header h1 { font-size: 1.2em; font-weight: 600; }
  .header .subtitle { font-size: 0.85em; color: var(--fg-dim); margin-top: 2px; }

  .container {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  /* Left: command timeline */
  .timeline {
    width: 320px;
    flex-shrink: 0;
    border-right: 1px solid var(--border);
    overflow-y: auto;
    padding: 8px 0;
  }

  .cmd-item {
    padding: 10px 16px;
    cursor: pointer;
    border-left: 3px solid transparent;
    transition: background 0.1s, border-color 0.1s;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .cmd-item:hover {
    background: var(--highlight);
  }

  .cmd-item.active {
    background: var(--highlight);
    border-left-color: var(--accent);
  }

  .cmd-item .seq {
    font-size: 0.75em;
    color: var(--fg-dim);
    font-variant-numeric: tabular-nums;
    width: 24px;
    text-align: right;
    flex-shrink: 0;
  }

  .cmd-item .cmd-info {
    flex: 1;
    min-width: 0;
  }

  .cmd-item .cmd-type {
    font-size: 0.85em;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cmd-item .cmd-meta {
    font-size: 0.72em;
    color: var(--fg-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cmd-item .response-badge {
    font-size: 0.7em;
    padding: 1px 6px;
    border-radius: 3px;
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }

  .badge-ok {
    background: color-mix(in srgb, var(--success) 20%, transparent);
    color: var(--success);
  }

  .badge-err {
    background: color-mix(in srgb, var(--error) 20%, transparent);
    color: var(--error);
  }

  /* Right: detail panel */
  .detail {
    flex: 1;
    overflow-y: auto;
    padding: 20px 24px;
  }

  .detail-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--fg-dim);
    font-size: 0.9em;
  }

  .pair {
    margin-bottom: 24px;
  }

  .pair-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
  }

  .pair-header .rid {
    font-weight: 600;
    font-size: 1.05em;
  }

  .pair-header .status {
    font-size: 0.8em;
    padding: 2px 8px;
    border-radius: 3px;
  }

  .pair-header .tool-name {
    font-size: 0.85em;
    color: var(--fg-dim);
  }

  .split-view {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .split-pane {
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }

  .pane-header {
    padding: 8px 14px;
    font-size: 0.72em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--fg-dim);
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--card-bg) 80%, var(--border));
  }

  .pane-body {
    padding: 12px 14px;
    max-height: 400px;
    overflow: auto;
  }

  pre {
    font-family: var(--mono);
    font-size: 0.82em;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-all;
  }

  /* JSON syntax highlighting */
  .json-key { color: var(--accent); }
  .json-str { color: var(--success); }
  .json-num { color: #dcdcaa; }
  .json-bool { color: #569cd6; }
  .json-null { color: var(--fg-dim); }

  footer {
    padding: 10px 24px;
    font-size: 0.72em;
    color: var(--fg-dim);
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
</style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(wsName)}</h1>
    <div class="subtitle">${commands.length} commands &middot; ${responses.length} responses</div>
  </div>

  <div class="container">
    <div class="timeline" id="timeline"></div>
    <div class="detail" id="detail">
      <div class="detail-empty">Select a command to view details</div>
    </div>
  </div>

  <footer>modiqo &middot; execution context</footer>

  <script>
    const commands = ${commandsJson};
    const responses = ${responsesJson};
    const responseMap = {};
    responses.forEach(r => { responseMap[r.id] = r; });

    const timeline = document.getElementById('timeline');
    const detail = document.getElementById('detail');
    let activeItem = null;

    function syntaxHighlight(json) {
      if (typeof json !== 'string') { json = JSON.stringify(json, null, 2); }
      return json
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"([^"]+)"(?=\\s*:)/g, '<span class="json-key">"$1"</span>')
        .replace(/:\\s*"([^"]*?)"/g, ': <span class="json-str">"$1"</span>')
        .replace(/:\\s*(\\d+\\.?\\d*)/g, ': <span class="json-num">$1</span>')
        .replace(/:\\s*(true|false)/g, ': <span class="json-bool">$1</span>')
        .replace(/:\\s*null/g, ': <span class="json-null">null</span>');
    }

    function truncateJson(obj, maxDepth, depth) {
      depth = depth || 0;
      if (depth >= maxDepth) {
        if (typeof obj === 'object' && obj !== null) {
          return Array.isArray(obj) ? '[...]' : '{...}';
        }
        return obj;
      }
      if (Array.isArray(obj)) {
        return obj.slice(0, 5).map(item => truncateJson(item, maxDepth, depth + 1));
      }
      if (typeof obj === 'object' && obj !== null) {
        const result = {};
        const keys = Object.keys(obj);
        keys.forEach(k => { result[k] = truncateJson(obj[k], maxDepth, depth + 1); });
        return result;
      }
      if (typeof obj === 'string' && obj.length > 200) {
        return obj.substring(0, 200) + '...';
      }
      return obj;
    }

    commands.forEach((cmd, idx) => {
      const item = document.createElement('div');
      item.className = 'cmd-item';

      const hasResponse = cmd.responseIds.length > 0;
      const rid = hasResponse ? '@' + cmd.responseIds[0] : '';
      const resp = hasResponse ? responseMap[rid] : null;
      const status = resp ? resp.status : null;

      let meta = '';
      if (cmd.command === 'HttpRequest') {
        const body = cmd.params.body || {};
        meta = body.method || body.params?.name || cmd.params.endpoint || '';
      } else if (cmd.command === 'SetVariable') {
        meta = cmd.params.name + ' = ' + cmd.params.value;
      } else if (cmd.command === 'QueryRead') {
        meta = cmd.params.query || '';
      }

      let badge = '';
      if (hasResponse && status !== null) {
        const cls = status >= 200 && status < 400 ? 'badge-ok' : 'badge-err';
        badge = '<span class="response-badge ' + cls + '">' + rid + '</span>';
      }

      item.innerHTML =
        '<div class="seq">#' + cmd.sequence + '</div>' +
        '<div class="cmd-info">' +
          '<div class="cmd-type">' + cmd.command + '</div>' +
          '<div class="cmd-meta">' + escapeHtmlJs(meta) + '</div>' +
        '</div>' +
        badge;

      item.addEventListener('click', () => {
        if (activeItem) activeItem.classList.remove('active');
        item.classList.add('active');
        activeItem = item;
        showDetail(cmd, resp);
      });

      timeline.appendChild(item);
    });

    function showDetail(cmd, resp) {
      let html = '';

      // Command detail
      html += '<div class="pair">';
      html += '<div class="pair-header">';
      html += '<span class="rid">#' + cmd.sequence + ' ' + cmd.command + '</span>';
      if (resp) {
        const statusCls = resp.status >= 200 && resp.status < 400 ? 'badge-ok' : 'badge-err';
        html += '<span class="status ' + statusCls + '">' + resp.status + '</span>';
        html += '<span class="tool-name">' + escapeHtmlJs(resp.toolName || '') + '</span>';
      }
      html += '</div>';

      if (resp) {
        // Split view: request | response
        const reqBody = truncateJson(resp.request, 4, 0);
        const respBody = truncateJson(resp.response, 3, 0);

        html += '<div class="split-view">';
        html += '<div class="split-pane">';
        html += '<div class="pane-header">Request</div>';
        html += '<div class="pane-body"><pre>' + syntaxHighlight(JSON.stringify(reqBody, null, 2)) + '</pre></div>';
        html += '</div>';
        html += '<div class="split-pane">';
        html += '<div class="pane-header">Response</div>';
        html += '<div class="pane-body"><pre>' + syntaxHighlight(JSON.stringify(respBody, null, 2)) + '</pre></div>';
        html += '</div>';
        html += '</div>';
      } else {
        // Command params only
        html += '<div class="split-pane" style="max-width:100%">';
        html += '<div class="pane-header">Parameters</div>';
        html += '<div class="pane-body"><pre>' + syntaxHighlight(JSON.stringify(cmd.params, null, 2)) + '</pre></div>';
        html += '</div>';
      }

      html += '</div>';
      detail.innerHTML = html;
    }

    function escapeHtmlJs(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Auto-select first command
    if (timeline.children.length > 0) {
      timeline.children[0].click();
    }
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
