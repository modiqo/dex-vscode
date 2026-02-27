import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

interface TraceBar {
  response_id: number;
  method: string;
  start_offset_ms: number;
  duration_ms: number;
  tokens: number | null;
  has_error: boolean;
  tool_name?: string;
  endpoint?: string;
}

interface WorkspaceInfo {
  name: string;
  dir: string;
  responseCount: number;
  strategy: string;
  endpoint: string;
  createdAt: string;
}

export function showTracePanel(
  extensionUri: vscode.Uri,
  ws: WorkspaceInfo
): void {
  const stateFile = path.join(ws.dir, ".dex", "state.json");
  if (!fs.existsSync(stateFile)) {
    vscode.window.showWarningMessage("No state.json found for this workspace.");
    return;
  }

  const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  const bars = buildTraceData(ws, state);

  if (bars.length === 0) {
    vscode.window.showInformationMessage("No trace data available.");
    return;
  }

  const totalMs = Math.max(
    ...bars.map((b) => b.start_offset_ms + b.duration_ms),
    1
  );
  const totalTokens = bars.reduce((s, b) => s + (b.tokens ?? 0), 0);
  const successCount = bars.filter((b) => !b.has_error).length;

  const panel = vscode.window.createWebviewPanel(
    "modiqo.trace",
    `Trace: ${ws.name}`,
    vscode.ViewColumn.One,
    { enableScripts: true }
  );

  panel.webview.html = buildTraceHtml(
    ws.name,
    bars,
    totalMs,
    totalTokens,
    successCount
  );
}

function buildTraceData(
  ws: WorkspaceInfo,
  state: { command_log: Array<{ sequence: number; type: { command: string; params: Record<string, unknown> }; response_ids: number[]; timestamp: string }> }
): TraceBar[] {
  const bars: TraceBar[] = [];
  const commandLog = state.command_log || [];

  // Find HttpRequest commands that have response_ids
  const httpCmds = commandLog.filter(
    (c) => c.type.command === "HttpRequest" && c.response_ids.length > 0
  );

  if (httpCmds.length === 0) { return []; }

  const baseTime = new Date(httpCmds[0].timestamp).getTime();

  for (const cmd of httpCmds) {
    const rid = cmd.response_ids[0];
    const params = cmd.type.params;
    const body = params.body as Record<string, unknown> | undefined;
    const method = (body?.method as string) ?? "request";
    const toolParams = body?.params as Record<string, unknown> | undefined;
    const toolName = (toolParams?.name as string) ?? method;

    // Read response file to get duration and tokens
    const responseFile = path.join(ws.dir, ".dex", "responses", `@${rid}.json`);
    let duration = 0;
    let tokens: number | null = null;
    let hasError = false;

    if (fs.existsSync(responseFile)) {
      try {
        const resp = JSON.parse(fs.readFileSync(responseFile, "utf-8"));
        const respTimestamp = resp.timestamp ? new Date(resp.timestamp).getTime() : 0;
        const cmdTimestamp = new Date(cmd.timestamp).getTime();

        // Find the next command's timestamp as proxy for end time
        const idx = commandLog.indexOf(cmd);
        const nextCmd = commandLog[idx + 1];
        if (nextCmd) {
          duration = new Date(nextCmd.timestamp).getTime() - cmdTimestamp;
        } else {
          // Last command — estimate from response body size
          const bodyStr = JSON.stringify(resp.response?.body ?? "");
          duration = Math.max(bodyStr.length / 100, 200);
        }

        // Token count from response body size
        const responseBody = JSON.stringify(resp.response?.body ?? "");
        tokens = Math.ceil(responseBody.length / 4); // rough estimate

        hasError = resp.response?.status >= 400;
      } catch { /* skip */ }
    }

    const startOffset = new Date(cmd.timestamp).getTime() - baseTime;

    bars.push({
      response_id: rid,
      method: toolName,
      start_offset_ms: Math.max(startOffset, 0),
      duration_ms: Math.max(duration, 50),
      tokens,
      has_error: hasError,
      tool_name: toolName,
      endpoint: params.endpoint as string,
    });
  }

  return bars;
}

function buildTraceHtml(
  wsName: string,
  bars: TraceBar[],
  totalMs: number,
  totalTokens: number,
  successCount: number
): string {
  const dataJson = JSON.stringify(bars);

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
    --bar-low: #3c8dbc;
    --bar-mid: #5dade2;
    --bar-high: #85c1e9;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--fg);
    background: var(--bg);
    padding: 24px 32px;
    line-height: 1.5;
  }

  .header { margin-bottom: 28px; }
  .header h1 {
    font-size: 1.4em;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .header .subtitle {
    color: var(--fg-dim);
    font-size: 0.9em;
    margin-top: 4px;
  }

  /* Stats grid */
  .stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
    margin-bottom: 28px;
  }
  .stat {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 14px 18px;
  }
  .stat-label {
    font-size: 0.7em;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--fg-dim);
    margin-bottom: 4px;
  }
  .stat-value {
    font-size: 1.5em;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  /* Chart */
  .chart-wrap {
    position: relative;
    overflow-x: auto;
    margin-bottom: 20px;
  }

  .chart-row {
    display: flex;
    align-items: center;
    height: 40px;
    margin-bottom: 2px;
  }

  .chart-label {
    width: 200px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 0.85em;
  }

  .chart-label .rid {
    color: var(--fg-dim);
    font-variant-numeric: tabular-nums;
    width: 30px;
    text-align: right;
  }

  .chart-label .method {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chart-bar-area {
    flex: 1;
    position: relative;
    height: 28px;
  }

  .bar {
    position: absolute;
    height: 100%;
    border-radius: 4px;
    cursor: pointer;
    transition: filter 0.15s;
    min-width: 4px;
  }

  .bar:hover {
    filter: brightness(1.3);
  }

  .bar-success { background: var(--success); }
  .bar-error { background: var(--error); }

  .bar-meta {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    font-size: 0.75em;
    color: var(--fg-dim);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  /* Axis */
  .axis {
    display: flex;
    margin-left: 200px;
    border-top: 1px solid var(--border);
    padding-top: 6px;
    margin-bottom: 24px;
  }
  .axis-tick {
    flex: 1;
    text-align: center;
    font-size: 0.7em;
    color: var(--fg-dim);
    font-variant-numeric: tabular-nums;
  }

  /* Tooltip */
  .tooltip {
    display: none;
    position: fixed;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px 16px;
    font-size: 0.85em;
    pointer-events: none;
    z-index: 100;
    box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    min-width: 200px;
  }
  .tooltip .tt-title { font-weight: 600; margin-bottom: 6px; }
  .tooltip .tt-row { color: var(--fg-dim); margin: 3px 0; }
  .tooltip .tt-row span { color: var(--fg); float: right; margin-left: 16px; font-variant-numeric: tabular-nums; }

  /* Legend */
  .legend {
    display: flex;
    gap: 20px;
    font-size: 0.75em;
    color: var(--fg-dim);
    margin-bottom: 16px;
  }
  .legend-item { display: flex; align-items: center; gap: 6px; }
  .swatch { width: 12px; height: 12px; border-radius: 3px; }

  footer {
    margin-top: 24px;
    font-size: 0.72em;
    color: var(--fg-dim);
  }
</style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(wsName)}</h1>
    <div class="subtitle">${bars.length} responses &middot; ${fmtMs(totalMs)} total</div>
  </div>

  <div class="stats">
    <div class="stat">
      <div class="stat-label">Duration</div>
      <div class="stat-value">${fmtMs(totalMs)}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Responses</div>
      <div class="stat-value">${bars.length}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Tokens</div>
      <div class="stat-value">${totalTokens.toLocaleString()}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Success</div>
      <div class="stat-value">${successCount}/${bars.length}</div>
    </div>
  </div>

  <div class="legend">
    <div class="legend-item"><div class="swatch" style="background:var(--success)"></div> Success</div>
    <div class="legend-item"><div class="swatch" style="background:var(--error)"></div> Error</div>
    <div class="legend-item">Opacity = token intensity</div>
  </div>

  <div class="chart-wrap" id="chart"></div>
  <div class="axis" id="axis"></div>

  <div class="tooltip" id="tooltip"></div>

  <footer>Generated by modiqo</footer>

  <script>
    const data = ${dataJson};
    const totalMs = ${totalMs};

    function fmtMs(ms) {
      return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
    }

    function tokenOpacity(tokens) {
      if (!tokens) return 0.5;
      if (tokens < 100) return 0.4;
      if (tokens < 1000) return 0.6;
      if (tokens < 10000) return 0.8;
      return 1.0;
    }

    const chart = document.getElementById('chart');
    const tooltip = document.getElementById('tooltip');

    data.forEach(bar => {
      const row = document.createElement('div');
      row.className = 'chart-row';

      const label = document.createElement('div');
      label.className = 'chart-label';
      label.innerHTML = '<span class="rid">@' + bar.response_id + '</span>' +
        '<span class="method">' + bar.method + '</span>';
      row.appendChild(label);

      const area = document.createElement('div');
      area.className = 'chart-bar-area';

      const barEl = document.createElement('div');
      barEl.className = 'bar ' + (bar.has_error ? 'bar-error' : 'bar-success');
      const left = (bar.start_offset_ms / totalMs) * 100;
      const width = Math.max((bar.duration_ms / totalMs) * 100, 0.5);
      barEl.style.left = left + '%';
      barEl.style.width = width + '%';
      barEl.style.opacity = tokenOpacity(bar.tokens);

      barEl.addEventListener('mousemove', e => {
        tooltip.style.display = 'block';
        tooltip.style.left = (e.clientX + 14) + 'px';
        tooltip.style.top = (e.clientY - 10) + 'px';
        tooltip.innerHTML =
          '<div class="tt-title">@' + bar.response_id + ' ' + bar.method + '</div>' +
          '<div class="tt-row">Duration <span>' + fmtMs(bar.duration_ms) + '</span></div>' +
          '<div class="tt-row">Tokens <span>' + (bar.tokens != null ? bar.tokens.toLocaleString() : '—') + '</span></div>' +
          '<div class="tt-row">Offset <span>' + fmtMs(bar.start_offset_ms) + '</span></div>' +
          '<div class="tt-row">Endpoint <span>' + (bar.endpoint || '—') + '</span></div>';
      });
      barEl.addEventListener('mouseout', () => { tooltip.style.display = 'none'; });

      area.appendChild(barEl);

      // Duration + token label after bar
      const meta = document.createElement('div');
      meta.className = 'bar-meta';
      meta.style.left = (left + width + 0.5) + '%';
      const tokStr = bar.tokens != null ? '[' + bar.tokens.toLocaleString() + ']' : '';
      meta.textContent = fmtMs(bar.duration_ms) + '  ' + tokStr;
      area.appendChild(meta);

      row.appendChild(area);
      chart.appendChild(row);
    });

    // Axis
    const axisEl = document.getElementById('axis');
    for (let i = 0; i <= 5; i++) {
      const tick = document.createElement('div');
      tick.className = 'axis-tick';
      tick.textContent = fmtMs(Math.round((i / 5) * totalMs));
      axisEl.appendChild(tick);
    }
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
