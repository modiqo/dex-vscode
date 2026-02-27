import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface ThinkingEntry {
  kind: "read" | "extract";
  source_response: number;
  query: string;
  source_tokens: number;
  result_tokens: number;
  variable_name: string;
}

interface TraceBar {
  response_id: number;
  method: string;
  start_offset_ms: number;
  duration_ms: number;
  tokens_in: number;
  tokens_out: number;
  tokens_total: number;
  has_error: boolean;
  tool_name: string;
  endpoint: string;
  tool_calls: ToolCall[];
  thinking: ThinkingEntry[];
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
  const totalTokens = bars.reduce((s, b) => s + b.tokens_total, 0);
  const totalTokensIn = bars.reduce((s, b) => s + b.tokens_in, 0);
  const totalTokensOut = bars.reduce((s, b) => s + b.tokens_out, 0);
  const successCount = bars.filter((b) => !b.has_error).length;
  const throughput = totalMs > 0 ? Math.round((totalTokens / totalMs) * 1000) : 0;

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
    totalTokensIn,
    totalTokensOut,
    successCount,
    throughput
  );
}

function buildTraceData(
  ws: WorkspaceInfo,
  state: { command_log: Array<{ sequence: number; type: { command: string; params: Record<string, unknown> }; response_ids: number[]; timestamp: string }> }
): TraceBar[] {
  const bars: TraceBar[] = [];
  const commandLog = state.command_log || [];

  // Collect thinking commands (QueryRead/QueryExtract) indexed by source_response
  const thinkingMap = new Map<number, ThinkingEntry[]>();
  for (const cmd of commandLog) {
    const cmdType = cmd.type.command;
    if (cmdType === "QueryRead" || cmdType === "QueryExtract") {
      const p = cmd.type.params;
      const srcResp = p.source_response as number;
      const entry: ThinkingEntry = {
        kind: cmdType === "QueryRead" ? "read" : "extract",
        source_response: srcResp,
        query: (p.query as string) ?? "",
        source_tokens: (p.source_response_tokens as number) ?? 0,
        result_tokens: (p.result_tokens as number) ?? 0,
        variable_name: (p.variable_name as string) ?? "",
      };
      const existing = thinkingMap.get(srcResp) || [];
      existing.push(entry);
      thinkingMap.set(srcResp, existing);
    }
  }

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

    // Extract nested tool calls for batch operations
    const toolCalls: ToolCall[] = [];
    const calls = toolParams?.calls as Array<{ tool_name: string; arguments: Record<string, unknown> }> | undefined;
    if (calls) {
      for (const call of calls) {
        toolCalls.push({ name: call.tool_name, args: call.arguments || {} });
      }
    }

    // Read response file for real metrics
    const responseFile = path.join(ws.dir, ".dex", "responses", `@${rid}.json`);
    let duration = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let tokensTotal = 0;
    let hasError = false;

    if (fs.existsSync(responseFile)) {
      try {
        const resp = JSON.parse(fs.readFileSync(responseFile, "utf-8"));

        // Use real duration_ms from response
        duration = resp.response?.duration_ms ?? 0;

        // Use real token counts
        const tokens = resp.tokens;
        if (tokens) {
          tokensIn = tokens.request_tokens ?? 0;
          tokensOut = tokens.response_tokens ?? 0;
          tokensTotal = tokens.total_tokens ?? 0;
        }

        hasError = resp.response?.status >= 400;
      } catch { /* skip */ }
    }

    // Fallback duration estimate if response file missing
    if (duration === 0) {
      const idx = commandLog.indexOf(cmd);
      const nextCmd = commandLog[idx + 1];
      if (nextCmd) {
        duration = new Date(nextCmd.timestamp).getTime() - new Date(cmd.timestamp).getTime();
      } else {
        duration = 200;
      }
    }

    const startOffset = new Date(cmd.timestamp).getTime() - baseTime;

    bars.push({
      response_id: rid,
      method: toolName,
      start_offset_ms: Math.max(startOffset, 0),
      duration_ms: Math.max(duration, 50),
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      tokens_total: tokensTotal,
      has_error: hasError,
      tool_name: toolName,
      endpoint: params.endpoint as string,
      tool_calls: toolCalls,
      thinking: thinkingMap.get(rid) || [],
    });
  }

  return bars;
}

function buildTraceHtml(
  wsName: string,
  bars: TraceBar[],
  totalMs: number,
  totalTokens: number,
  totalTokensIn: number,
  totalTokensOut: number,
  successCount: number,
  throughput: number
): string {
  const dataJson = JSON.stringify(bars);
  const tokenInPct = totalTokens > 0 ? Math.round((totalTokensIn / totalTokens) * 100) : 50;

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
    --success-dark: #2d8a6e;
    --error: #f14c4c;
    --error-dark: #a33;
    --mono: var(--vscode-editor-font-family, 'SF Mono', 'Fira Code', monospace);
    --orange: #E87A2A;
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
  .header h1 { font-size: 1.4em; font-weight: 600; }
  .header .subtitle { color: var(--fg-dim); font-size: 0.9em; margin-top: 4px; }

  /* ── Stats ── */
  .stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
    margin-bottom: 32px;
  }

  .stat-card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 18px 20px;
    position: relative;
    overflow: hidden;
  }

  .stat-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
    border-radius: 10px 10px 0 0;
  }

  .stat-card.duration::before { background: var(--accent); }
  .stat-card.responses::before { background: var(--success); }
  .stat-card.tokens::before { background: var(--orange); }
  .stat-card.throughput::before { background: var(--fg-dim); }

  .stat-label {
    font-size: 0.68em;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--fg-dim);
    margin-bottom: 6px;
  }

  .stat-value {
    font-size: 1.8em;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }

  .stat-sub {
    font-size: 0.72em;
    color: var(--fg-dim);
    margin-top: 8px;
  }

  /* Token donut */
  .donut {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    position: absolute;
    right: 16px;
    top: 50%;
    transform: translateY(-50%);
  }

  .donut-hole {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--card-bg);
    position: absolute;
    top: 8px;
    left: 8px;
  }

  /* Success ring */
  .success-ring {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    position: absolute;
    right: 16px;
    top: 50%;
    transform: translateY(-50%);
  }

  .success-ring-hole {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--card-bg);
    position: absolute;
    top: 7px;
    left: 7px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.55em;
    font-weight: 700;
    color: var(--success);
  }

  /* Duration breakdown bar */
  .duration-breakdown {
    display: flex;
    height: 4px;
    border-radius: 2px;
    overflow: hidden;
    margin-top: 10px;
    gap: 1px;
  }

  .duration-seg {
    height: 100%;
    border-radius: 1px;
    min-width: 2px;
  }

  /* ── Timeline ── */
  .timeline-container {
    position: relative;
    margin-bottom: 8px;
  }

  .gridlines {
    position: absolute;
    top: 0;
    left: 200px;
    right: 0;
    bottom: 0;
    pointer-events: none;
  }

  .gridline {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--border);
    opacity: 0.25;
  }

  .chart-row {
    display: flex;
    align-items: center;
    min-height: 36px;
    position: relative;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 20%, transparent);
    transition: background 0.15s;
  }

  .chart-row:hover {
    background: color-mix(in srgb, var(--accent) 4%, transparent);
  }

  .chart-label {
    width: 200px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 0.85em;
    padding: 8px 0;
  }

  .chart-label .rid {
    color: var(--fg-dim);
    font-variant-numeric: tabular-nums;
    font-family: var(--mono);
    font-size: 0.85em;
    width: 30px;
    text-align: right;
  }

  .chart-label .method {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }

  .chart-bar-area {
    flex: 1;
    position: relative;
    height: 20px;
  }

  .flame-bar {
    position: absolute;
    border-radius: 5px;
    cursor: pointer;
    min-width: 6px;
    display: flex;
    align-items: center;
    overflow: hidden;
    transition: transform 0.1s, box-shadow 0.15s;
  }

  .flame-bar:hover {
    transform: scaleY(1.15);
    box-shadow: 0 2px 12px rgba(78, 201, 176, 0.3);
    z-index: 5;
  }

  .flame-bar.error:hover {
    box-shadow: 0 2px 12px rgba(241, 76, 76, 0.3);
  }

  .flame-bar.success {
    background: linear-gradient(90deg, var(--success-dark), var(--success));
  }

  .flame-bar.error {
    background: linear-gradient(90deg, var(--error-dark), var(--error));
  }

  /* Nested tool segments inside batch bars */
  .tool-segment {
    height: 100%;
    flex-shrink: 0;
    border-right: 1px solid rgba(255,255,255,0.15);
    position: relative;
  }

  .tool-segment:last-child {
    border-right: none;
  }

  .bar-meta {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    font-size: 0.72em;
    color: var(--fg-dim);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    font-family: var(--mono);
  }

  /* Thinking sub-row (QueryRead/QueryExtract cross-references) */
  .thinking-row {
    display: flex;
    align-items: center;
    min-height: 24px;
    padding: 2px 0 2px 200px;
    font-size: 0.75em;
    color: var(--fg-dim);
    font-family: var(--mono);
    border-bottom: 1px solid color-mix(in srgb, var(--border) 10%, transparent);
    gap: 8px;
  }

  .thinking-row .think-icon {
    color: var(--accent);
    font-size: 0.9em;
    flex-shrink: 0;
  }

  .thinking-row .think-ref {
    color: var(--fg-dim);
    flex-shrink: 0;
  }

  .thinking-row .think-query {
    color: var(--fg);
    opacity: 0.8;
  }

  .thinking-row .think-tokens {
    color: var(--fg-dim);
    flex-shrink: 0;
  }

  .thinking-row .think-saved {
    color: var(--success);
    font-weight: 500;
    flex-shrink: 0;
  }

  .thinking-row .think-var {
    color: var(--orange);
    flex-shrink: 0;
  }

  /* Expandable detail card */
  .detail-card {
    display: none;
    margin: 0 0 4px 200px;
    padding: 14px 18px;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 0.82em;
    animation: slideDown 0.2s ease;
  }

  @keyframes slideDown {
    from { opacity: 0; transform: translateY(-8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .detail-card.open {
    display: block;
  }

  .detail-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    margin-bottom: 12px;
  }

  .detail-metric {
    padding: 8px 12px;
    background: color-mix(in srgb, var(--border) 15%, transparent);
    border-radius: 6px;
  }

  .detail-metric-label {
    font-size: 0.8em;
    color: var(--fg-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .detail-metric-value {
    font-size: 1.2em;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    font-family: var(--mono);
  }

  .detail-metric-value.in { color: var(--accent); }
  .detail-metric-value.out { color: var(--orange); }

  .tool-calls-title {
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--fg-dim);
    margin-bottom: 6px;
  }

  .tool-call-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 0;
    font-family: var(--mono);
    font-size: 0.9em;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 30%, transparent);
  }

  .tool-call-row:last-child { border-bottom: none; }

  .tool-call-name { font-weight: 500; }
  .tool-call-args { color: var(--fg-dim); font-size: 0.85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Token bar inline */
  .token-split {
    display: flex;
    height: 6px;
    border-radius: 3px;
    overflow: hidden;
    margin-top: 4px;
    width: 100%;
  }

  .token-split-in {
    background: var(--accent);
    height: 100%;
  }

  .token-split-out {
    background: var(--orange);
    height: 100%;
  }

  /* ── Time axis ── */
  .axis {
    display: flex;
    margin-left: 200px;
    border-top: 1px solid var(--border);
    padding-top: 6px;
    margin-bottom: 28px;
  }

  .axis-tick {
    flex: 1;
    text-align: center;
    font-size: 0.68em;
    color: var(--fg-dim);
    font-variant-numeric: tabular-nums;
    font-family: var(--mono);
  }

  /* ── Token waterfall ── */
  .waterfall-section {
    margin-bottom: 28px;
  }

  .waterfall-title {
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--fg-dim);
    margin-bottom: 10px;
  }

  .waterfall-chart {
    position: relative;
    height: 60px;
    margin-left: 200px;
    border: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
    border-radius: 6px;
    overflow: hidden;
    background: var(--card-bg);
  }

  .waterfall-area {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
  }

  .waterfall-fill {
    position: absolute;
    bottom: 0;
  }

  .waterfall-label {
    display: flex;
    justify-content: space-between;
    margin-left: 200px;
    margin-top: 4px;
    font-size: 0.65em;
    color: var(--fg-dim);
    font-family: var(--mono);
  }

  /* Tooltip */
  .tooltip {
    display: none;
    position: fixed;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 18px;
    font-size: 0.85em;
    pointer-events: none;
    z-index: 100;
    box-shadow: 0 6px 24px rgba(0,0,0,0.35);
    min-width: 240px;
    max-width: 400px;
  }

  .tooltip .tt-title {
    font-weight: 600;
    margin-bottom: 8px;
    font-size: 1.05em;
  }

  .tooltip .tt-row {
    display: flex;
    justify-content: space-between;
    color: var(--fg-dim);
    margin: 4px 0;
    font-size: 0.9em;
  }

  .tooltip .tt-row span {
    color: var(--fg);
    font-variant-numeric: tabular-nums;
    font-family: var(--mono);
  }

  .tooltip .tt-divider {
    border-top: 1px solid var(--border);
    margin: 6px 0;
  }

  .tooltip .tt-batch {
    font-size: 0.8em;
    color: var(--fg-dim);
    margin-top: 6px;
  }

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

  <!-- Stats -->
  <div class="stats">
    <div class="stat-card duration">
      <div class="stat-label">Duration</div>
      <div class="stat-value">${fmtMs(totalMs)}</div>
      <div class="duration-breakdown" id="dur-breakdown"></div>
    </div>

    <div class="stat-card responses">
      <div class="stat-label">Responses</div>
      <div class="stat-value">${bars.length}</div>
      <div class="stat-sub">${successCount} success &middot; ${bars.length - successCount} error</div>
      <div class="success-ring" style="background: conic-gradient(var(--success) ${Math.round((successCount / bars.length) * 360)}deg, var(--border) 0deg);">
        <div class="success-ring-hole">${Math.round((successCount / bars.length) * 100)}%</div>
      </div>
    </div>

    <div class="stat-card tokens">
      <div class="stat-label">Tokens</div>
      <div class="stat-value">${totalTokens.toLocaleString()}</div>
      <div class="stat-sub">${totalTokensIn.toLocaleString()} in &middot; ${totalTokensOut.toLocaleString()} out</div>
      <div class="donut" style="background: conic-gradient(var(--accent) ${tokenInPct * 3.6}deg, var(--orange) 0deg);">
        <div class="donut-hole"></div>
      </div>
    </div>

    <div class="stat-card throughput">
      <div class="stat-label">Throughput</div>
      <div class="stat-value">${throughput.toLocaleString()}</div>
      <div class="stat-sub">tokens / second</div>
    </div>
  </div>

  <!-- Timeline -->
  <div class="timeline-container" id="timeline"></div>
  <div class="axis" id="axis"></div>

  <!-- Token Waterfall -->
  <div class="waterfall-section">
    <div class="waterfall-title">Token Consumption</div>
    <div class="waterfall-chart" id="waterfall"></div>
    <div class="waterfall-label">
      <span>0</span>
      <span>${totalTokens.toLocaleString()} tokens</span>
    </div>
  </div>

  <div class="tooltip" id="tooltip"></div>

  <footer>modiqo &middot; trace</footer>

  <script>
    const data = ${dataJson};
    const totalMs = ${totalMs};
    const totalTokens = ${totalTokens};

    function fmtMs(ms) {
      return ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's';
    }

    function fmtTokens(n) {
      return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n.toString();
    }

    function barHeight(tokens) {
      if (!tokens) return 14;
      if (tokens < 500) return 14;
      if (tokens < 5000) return 16;
      if (tokens < 50000) return 18;
      return 20;
    }

    const timeline = document.getElementById('timeline');
    const tooltip = document.getElementById('tooltip');

    // Gridlines
    const gridEl = document.createElement('div');
    gridEl.className = 'gridlines';
    gridEl.style.position = 'absolute';
    gridEl.style.top = '0';
    gridEl.style.left = '200px';
    gridEl.style.right = '0';
    gridEl.style.bottom = '0';
    gridEl.style.pointerEvents = 'none';
    for (let i = 1; i <= 5; i++) {
      const line = document.createElement('div');
      line.className = 'gridline';
      line.style.left = (i * 20) + '%';
      gridEl.appendChild(line);
    }
    timeline.style.position = 'relative';
    timeline.appendChild(gridEl);

    // Bars
    data.forEach((bar, idx) => {
      const wrapper = document.createElement('div');

      const row = document.createElement('div');
      row.className = 'chart-row';
      row.style.cursor = 'pointer';

      const label = document.createElement('div');
      label.className = 'chart-label';
      label.innerHTML = '<span class="rid">@' + bar.response_id + '</span><span class="method">' + escapeHtml(bar.method) + '</span>';
      row.appendChild(label);

      const area = document.createElement('div');
      area.className = 'chart-bar-area';

      const h = barHeight(bar.tokens_total);
      const flameBar = document.createElement('div');
      flameBar.className = 'flame-bar ' + (bar.has_error ? 'error' : 'success');
      const left = (bar.start_offset_ms / totalMs) * 100;
      const width = Math.max((bar.duration_ms / totalMs) * 100, 0.8);
      flameBar.style.left = left + '%';
      flameBar.style.width = width + '%';
      flameBar.style.height = h + 'px';
      flameBar.style.top = ((20 - h) / 2) + 'px';

      // Nested tool segments for batch calls
      if (bar.tool_calls.length > 1) {
        bar.tool_calls.forEach((tc, i) => {
          const seg = document.createElement('div');
          seg.className = 'tool-segment';
          seg.style.flex = '1';
          seg.style.opacity = 0.7 + (i % 2) * 0.3;
          flameBar.appendChild(seg);
        });
      }

      // Tooltip on hover
      flameBar.addEventListener('mousemove', e => {
        tooltip.style.display = 'block';
        tooltip.style.left = Math.min(e.clientX + 14, window.innerWidth - 420) + 'px';
        tooltip.style.top = (e.clientY - 10) + 'px';

        let html = '<div class="tt-title">@' + bar.response_id + ' ' + escapeHtml(bar.method) + '</div>';
        html += '<div class="tt-row">Duration <span>' + fmtMs(bar.duration_ms) + '</span></div>';
        html += '<div class="tt-row">Tokens in <span>' + bar.tokens_in.toLocaleString() + '</span></div>';
        html += '<div class="tt-row">Tokens out <span>' + bar.tokens_out.toLocaleString() + '</span></div>';
        html += '<div class="tt-row">Total <span>' + bar.tokens_total.toLocaleString() + '</span></div>';
        html += '<div class="tt-row">Offset <span>' + fmtMs(bar.start_offset_ms) + '</span></div>';

        if (bar.tool_calls.length > 0) {
          html += '<div class="tt-divider"></div>';
          html += '<div class="tt-batch">' + bar.tool_calls.length + ' tool calls (click to expand)</div>';
        }

        tooltip.innerHTML = html;
      });

      flameBar.addEventListener('mouseout', () => { tooltip.style.display = 'none'; });

      area.appendChild(flameBar);

      // Meta label after bar
      const meta = document.createElement('div');
      meta.className = 'bar-meta';
      meta.style.left = (left + width + 0.5) + '%';
      meta.textContent = fmtMs(bar.duration_ms) + '  [' + fmtTokens(bar.tokens_total) + ']';
      area.appendChild(meta);

      row.appendChild(area);
      wrapper.appendChild(row);

      // Thinking sub-rows (QueryRead/QueryExtract cross-references)
      if (bar.thinking && bar.thinking.length > 0) {
        bar.thinking.forEach(t => {
          const tRow = document.createElement('div');
          tRow.className = 'thinking-row';

          let html = '<span class="think-icon">' + (t.kind === 'read' ? '&#9671;' : '&#9655;') + '</span>';
          html += '<span class="think-ref">@' + t.source_response + '</span>';
          html += '<span class="think-query">' + escapeHtml(t.query) + '</span>';

          if (t.result_tokens > 0) {
            html += '<span class="think-tokens">[' + fmtTokens(t.result_tokens) + 'tk]</span>';
          }

          if (t.source_tokens > 0 && t.result_tokens > 0) {
            const saved = t.source_tokens - t.result_tokens;
            if (saved > 0) {
              html += '<span class="think-saved">saved ' + saved.toLocaleString() + '</span>';
            }
          }

          if (t.variable_name) {
            html += '<span class="think-var">$' + escapeHtml(t.variable_name) + '</span>';
          }

          html += '<span class="think-icon" style="opacity:0.4">' + (t.kind === 'read' ? '&#x3008;think&#x3009;' : '&#x3008;extract&#x3009;') + '</span>';

          tRow.innerHTML = html;
          wrapper.appendChild(tRow);
        });
      }

      // Detail card (expandable on click)
      const detail = document.createElement('div');
      detail.className = 'detail-card';
      detail.id = 'detail-' + idx;

      let detailHtml = '<div class="detail-grid">';
      detailHtml += '<div class="detail-metric"><div class="detail-metric-label">Duration</div><div class="detail-metric-value">' + fmtMs(bar.duration_ms) + '</div></div>';
      detailHtml += '<div class="detail-metric"><div class="detail-metric-label">Tokens In</div><div class="detail-metric-value in">' + bar.tokens_in.toLocaleString() + '</div></div>';
      detailHtml += '<div class="detail-metric"><div class="detail-metric-label">Tokens Out</div><div class="detail-metric-value out">' + bar.tokens_out.toLocaleString() + '</div></div>';
      detailHtml += '</div>';

      // Token split bar
      const inPct = bar.tokens_total > 0 ? (bar.tokens_in / bar.tokens_total) * 100 : 50;
      detailHtml += '<div class="token-split"><div class="token-split-in" style="width:' + inPct + '%"></div><div class="token-split-out" style="width:' + (100 - inPct) + '%"></div></div>';

      // Tool calls
      if (bar.tool_calls.length > 0) {
        detailHtml += '<div style="margin-top:12px"><div class="tool-calls-title">Tool Calls (' + bar.tool_calls.length + ')</div>';
        bar.tool_calls.forEach(tc => {
          const argsStr = Object.entries(tc.args).map(([k,v]) => k + '=' + JSON.stringify(v)).join(', ');
          detailHtml += '<div class="tool-call-row"><span class="tool-call-name">' + escapeHtml(tc.name) + '</span><span class="tool-call-args">' + escapeHtml(argsStr) + '</span></div>';
        });
        detailHtml += '</div>';
      }

      // Thinking / cross-references
      if (bar.thinking && bar.thinking.length > 0) {
        detailHtml += '<div style="margin-top:12px"><div class="tool-calls-title">Thinking (' + bar.thinking.length + ')</div>';
        bar.thinking.forEach(t => {
          const saved = t.source_tokens > 0 && t.result_tokens > 0 ? t.source_tokens - t.result_tokens : 0;
          detailHtml += '<div class="tool-call-row">';
          detailHtml += '<span class="tool-call-name" style="color:var(--accent)">' + (t.kind === 'read' ? 'read' : 'extract') + '</span>';
          detailHtml += '<span class="tool-call-args">@' + t.source_response + ' ' + escapeHtml(t.query);
          if (t.result_tokens > 0) detailHtml += '  [' + t.result_tokens.toLocaleString() + ' tk]';
          if (saved > 0) detailHtml += '  saved ' + saved.toLocaleString();
          if (t.variable_name) detailHtml += '  &rarr; $' + escapeHtml(t.variable_name);
          detailHtml += '</span>';
          detailHtml += '</div>';
        });
        detailHtml += '</div>';
      }

      detail.innerHTML = detailHtml;
      wrapper.appendChild(detail);

      // Click to toggle detail
      row.addEventListener('click', () => {
        detail.classList.toggle('open');
      });

      timeline.appendChild(wrapper);
    });

    // Duration breakdown in stats
    const durBreakdown = document.getElementById('dur-breakdown');
    const colors = ['var(--success)', 'var(--accent)', 'var(--orange)', '#a78bfa', '#f472b6'];
    data.forEach((bar, i) => {
      const seg = document.createElement('div');
      seg.className = 'duration-seg';
      seg.style.flex = bar.duration_ms;
      seg.style.background = bar.has_error ? 'var(--error)' : colors[i % colors.length];
      seg.title = '@' + bar.response_id + ': ' + fmtMs(bar.duration_ms);
      durBreakdown.appendChild(seg);
    });

    // Axis
    const axisEl = document.getElementById('axis');
    for (let i = 0; i <= 5; i++) {
      const tick = document.createElement('div');
      tick.className = 'axis-tick';
      tick.textContent = fmtMs(Math.round((i / 5) * totalMs));
      axisEl.appendChild(tick);
    }

    // Token waterfall
    const waterfallEl = document.getElementById('waterfall');
    let cumulative = 0;
    data.forEach(bar => {
      const startPct = (bar.start_offset_ms / totalMs) * 100;
      const widthPct = Math.max((bar.duration_ms / totalMs) * 100, 0.5);
      cumulative += bar.tokens_total;
      const heightPct = totalTokens > 0 ? (cumulative / totalTokens) * 100 : 0;

      const fill = document.createElement('div');
      fill.className = 'waterfall-fill';
      fill.style.left = startPct + '%';
      fill.style.width = widthPct + '%';
      fill.style.height = heightPct + '%';
      fill.style.background = bar.has_error ? 'var(--error)' : 'color-mix(in srgb, var(--success) 40%, transparent)';
      fill.style.borderRadius = '2px 2px 0 0';
      waterfallEl.appendChild(fill);
    });

    function escapeHtml(s) {
      if (!s) return '';
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
