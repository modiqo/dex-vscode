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
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    }
  );

  const d3Uri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "d3-trace.min.js")
  );

  panel.webview.html = buildTraceHtml(
    ws.name,
    bars,
    totalMs,
    totalTokens,
    totalTokensIn,
    totalTokensOut,
    successCount,
    throughput,
    d3Uri.toString()
  );
}

function buildTraceData(
  ws: WorkspaceInfo,
  state: { command_log: Array<{ sequence: number; type: { command: string; params: Record<string, unknown> }; response_ids: number[]; timestamp: string }> }
): TraceBar[] {
  const bars: TraceBar[] = [];
  const commandLog = state.command_log || [];

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

    const toolCalls: ToolCall[] = [];
    const calls = toolParams?.calls as Array<{ tool_name: string; arguments: Record<string, unknown> }> | undefined;
    if (calls) {
      for (const call of calls) {
        toolCalls.push({ name: call.tool_name, args: call.arguments || {} });
      }
    }

    const responseFile = path.join(ws.dir, ".dex", "responses", `@${rid}.json`);
    let duration = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let tokensTotal = 0;
    let hasError = false;

    if (fs.existsSync(responseFile)) {
      try {
        const resp = JSON.parse(fs.readFileSync(responseFile, "utf-8"));
        duration = resp.response?.duration_ms ?? 0;
        const tokens = resp.tokens;
        if (tokens) {
          tokensIn = tokens.request_tokens ?? 0;
          tokensOut = tokens.response_tokens ?? 0;
          tokensTotal = tokens.total_tokens ?? 0;
        }
        hasError = resp.response?.status >= 400;
      } catch { /* skip */ }
    }

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

// ── Ticker helpers ───────────────────────────────────────────────

function tickerBar(value: number, max: number, width: number): string {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  const empty = width - filled;
  return `<span class="tk-fill">${"\u2588".repeat(filled)}</span><span class="tk-empty">${"\u2591".repeat(empty)}</span>`;
}

function fmtTokensShort(n: number): string {
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
  if (n >= 1_000) { return `${(n / 1000).toFixed(1)}k`; }
  return n.toString();
}

// ── Pulse Meter SVG ──────────────────────────────────────────────

function buildPulseSvg(bars: TraceBar[], totalMs: number, _totalTokens: number): string {
  if (bars.length === 0) { return ""; }

  const width = 600;
  const height = 60;
  const maxTk = Math.max(...bars.map(b => b.tokens_total), 1);

  // Build polyline points: flat baseline with spikes at each query
  const points: string[] = [`0,${height}`];

  for (const bar of bars) {
    const x = totalMs > 0 ? (bar.start_offset_ms / totalMs) * width : 0;
    const spikeH = Math.max((bar.tokens_total / maxTk) * (height - 10), 4);
    const xEnd = totalMs > 0 ? ((bar.start_offset_ms + bar.duration_ms) / totalMs) * width : x + 10;

    // Approach baseline, spike up, come back
    points.push(`${Math.max(x - 4, 0)},${height}`);
    points.push(`${x},${height - spikeH}`);
    points.push(`${(x + xEnd) / 2},${height - spikeH * 0.3}`);
    points.push(`${xEnd},${height - spikeH * 0.7}`);
    points.push(`${Math.min(xEnd + 4, width)},${height}`);
  }

  points.push(`${width},${height}`);

  return `<svg viewBox="0 0 ${width} ${height + 8}" class="pulse-svg" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="pulse-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" style="stop-color: var(--success); stop-opacity: 0.3"/>
        <stop offset="100%" style="stop-color: var(--success); stop-opacity: 0.02"/>
      </linearGradient>
    </defs>
    <line x1="0" y1="${height}" x2="${width}" y2="${height}" style="stroke: var(--border); stroke-width: 1; stroke-dasharray: 4 4; stroke-opacity: 0.4"/>
    <polygon points="${points.join(" ")}" style="fill: url(#pulse-fill)"/>
    <polyline points="${points.join(" ")}" class="pulse-line" style="fill: none; stroke: var(--success); stroke-width: 1.5; stroke-linecap: round"/>
  </svg>`;
}

function buildTraceHtml(
  wsName: string,
  bars: TraceBar[],
  totalMs: number,
  totalTokens: number,
  totalTokensIn: number,
  totalTokensOut: number,
  successCount: number,
  throughput: number,
  d3ScriptUri: string
): string {
  const dataJson = JSON.stringify(bars);
  const errorCount = bars.length - successCount;
  const barWidth = 28;

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
    --mono: var(--vscode-editor-font-family, 'SF Mono', 'Fira Code', monospace);
  }

  body.vscode-dark, body.vscode-high-contrast {
    --success: #4ec9b0;
    --success-dark: #2d8a6e;
    --error: #f14c4c;
    --error-dark: #a33;
    --orange: #E87A2A;
    --ticker-bg: rgba(255,255,255,0.03);
    --grad-success-start: #2d8a6e;
    --grad-success-end: #4ec9b0;
    --grad-error-start: #a33;
    --grad-error-end: #f14c4c;
    --waterfall-start: rgba(78,201,176,0.05);
    --waterfall-end: rgba(78,201,176,0.35);
    --waterfall-stroke: #4ec9b0;
  }

  body.vscode-light {
    --success: #16825d;
    --success-dark: #0e5c42;
    --error: #cd3131;
    --error-dark: #a02020;
    --orange: #c05621;
    --ticker-bg: rgba(0,0,0,0.03);
    --grad-success-start: #0e5c42;
    --grad-success-end: #16825d;
    --grad-error-start: #a02020;
    --grad-error-end: #cd3131;
    --waterfall-start: rgba(22,130,93,0.05);
    --waterfall-end: rgba(22,130,93,0.3);
    --waterfall-stroke: #16825d;
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

  /* ── Terminal Ticker ───────────── */
  .ticker {
    background: var(--ticker-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 20px;
    margin-bottom: 28px;
    font-family: var(--mono);
    font-size: 13px;
  }
  .ticker-line {
    line-height: 2.4;
    white-space: pre;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .tk-label {
    color: var(--fg-dim);
    display: inline-block;
    width: 14ch;
    flex-shrink: 0;
  }
  .tk-fill { color: var(--success); }
  .tk-fill.error { color: var(--error); }
  .tk-empty { color: var(--border); opacity: 0.5; }
  .tk-val {
    color: var(--fg);
    font-weight: 600;
    margin-left: 4px;
    min-width: 8ch;
    text-align: right;
  }
  .tk-dim { color: var(--fg-dim); font-size: 0.9em; }

  .section-label {
    font-size: 0.68em; text-transform: uppercase;
    letter-spacing: 0.1em; color: var(--fg-dim);
    margin-bottom: 10px;
  }

  /* ── Duration Breakdown (mini bar) */
  .duration-breakdown {
    display: flex; height: 4px; border-radius: 2px;
    overflow: hidden; margin: 8px 0 0 0; gap: 1px;
  }
  .duration-seg { height: 100%; border-radius: 1px; min-width: 2px; }

  /* ── Pulse Meter ───────────────── */
  .pulse-section { margin-bottom: 24px; }
  .pulse-svg { width: 100%; height: auto; }
  .pulse-line {
    animation: pulse-draw 2s ease-out forwards;
    stroke-dasharray: 1200;
    stroke-dashoffset: 1200;
  }
  @keyframes pulse-draw {
    to { stroke-dashoffset: 0; }
  }
  .pulse-legend {
    display: flex; gap: 20px; margin-top: 6px;
    font-size: 0.65em; color: var(--fg-dim); font-family: var(--mono);
    justify-content: space-between;
  }

  /* ── Timeline ──────────────────── */
  #chart-container { width: 100%; margin-bottom: 8px; }
  #chart-container svg { display: block; width: 100%; }

  .bar-rect { cursor: pointer; transition: opacity 0.12s; }
  .bar-rect:hover { opacity: 0.85; }

  .axis-line { stroke: var(--border); stroke-width: 1; }
  .grid-line { stroke: var(--border); stroke-width: 1; stroke-dasharray: 3,3; opacity: 0.25; }

  .label-text {
    font-family: var(--mono);
    font-size: 11px;
    fill: var(--fg-dim);
  }
  .method-text {
    font-size: 12px;
    font-weight: 500;
    fill: var(--fg);
  }
  .meta-text {
    font-family: var(--mono);
    font-size: 10px;
    fill: var(--fg-dim);
  }
  .think-text {
    font-family: var(--mono);
    font-size: 10px;
    fill: var(--fg-dim);
  }
  .think-icon-text { fill: var(--accent); }
  .think-saved-text { fill: var(--success); font-weight: 500; }
  .think-var-text { fill: var(--orange); }
  .axis-text {
    font-family: var(--mono);
    font-size: 10px;
    fill: var(--fg-dim);
  }

  /* ── Detail cards ──────────────── */
  .detail-cards-container { margin-left: 0; }

  .detail-card {
    display: none;
    padding: 14px 18px;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 0.82em;
    margin-bottom: 4px;
    animation: slideDown 0.2s ease;
  }
  @keyframes slideDown {
    from { opacity: 0; transform: translateY(-8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .detail-card.open { display: block; }

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
    font-size: 0.8em; color: var(--fg-dim);
    text-transform: uppercase; letter-spacing: 0.06em;
  }
  .detail-metric-value {
    font-size: 1.2em; font-weight: 600;
    font-variant-numeric: tabular-nums; font-family: var(--mono);
  }
  .detail-metric-value.in { color: var(--accent); }
  .detail-metric-value.out { color: var(--orange); }

  .tool-calls-title {
    font-size: 0.75em; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--fg-dim); margin-bottom: 6px;
  }
  .tool-call-row {
    display: flex; align-items: center; gap: 10px;
    padding: 4px 0; font-family: var(--mono); font-size: 0.9em;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 30%, transparent);
  }
  .tool-call-row:last-child { border-bottom: none; }
  .tool-call-name { font-weight: 500; }
  .tool-call-args { color: var(--fg-dim); font-size: 0.85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .token-split { display: flex; height: 6px; border-radius: 3px; overflow: hidden; margin-top: 4px; width: 100%; }
  .token-split-in { background: var(--accent); height: 100%; }
  .token-split-out { background: var(--orange); height: 100%; }

  /* ── Waterfall ─────────────────── */
  .waterfall-section { margin-bottom: 28px; }
  .waterfall-title {
    font-size: 0.75em; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--fg-dim); margin-bottom: 10px;
  }
  #waterfall-container { width: 100%; }
  #waterfall-container svg { display: block; width: 100%; }
  .waterfall-label {
    display: flex; justify-content: space-between;
    margin-top: 4px; font-size: 0.65em; color: var(--fg-dim); font-family: var(--mono);
  }

  /* ── Tooltip ───────────────────── */
  .tooltip {
    display: none; position: fixed;
    background: var(--card-bg); border: 1px solid var(--border);
    border-radius: 8px; padding: 14px 18px; font-size: 0.85em;
    pointer-events: none; z-index: 100;
    box-shadow: 0 6px 24px rgba(0,0,0,0.15);
    min-width: 240px; max-width: 400px;
  }
  .tooltip .tt-title { font-weight: 600; margin-bottom: 8px; font-size: 1.05em; }
  .tooltip .tt-row { display: flex; justify-content: space-between; color: var(--fg-dim); margin: 4px 0; font-size: 0.9em; }
  .tooltip .tt-row span { color: var(--fg); font-variant-numeric: tabular-nums; font-family: var(--mono); }
  .tooltip .tt-divider { border-top: 1px solid var(--border); margin: 6px 0; }
  .tooltip .tt-batch { font-size: 0.8em; color: var(--fg-dim); margin-top: 6px; }

  footer { margin-top: 24px; font-size: 0.72em; color: var(--fg-dim); }
</style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(wsName)}</h1>
    <div class="subtitle">${bars.length} responses &middot; ${fmtMs(totalMs)} total</div>
  </div>

  <!-- Terminal Ticker -->
  <div class="ticker">
    <div class="ticker-line">
      <span class="tk-label">duration</span>
      ${tickerBar(totalMs, totalMs, barWidth)}
      <span class="tk-val">${fmtMs(totalMs)}</span>
    </div>
    <div class="ticker-line">
      <span class="tk-label">responses</span>
      ${tickerBar(successCount, bars.length, barWidth)}
      <span class="tk-val">${bars.length}</span>
      <span class="tk-dim">${successCount} ok${errorCount > 0 ? ` &middot; <span style="color:var(--error)">${errorCount} err</span>` : ""}</span>
    </div>
    <div class="ticker-line">
      <span class="tk-label">tokens</span>
      ${tickerBar(totalTokensIn, totalTokens, barWidth)}
      <span class="tk-val">${totalTokens.toLocaleString()}</span>
      <span class="tk-dim">${fmtTokensShort(totalTokensIn)} in &middot; ${fmtTokensShort(totalTokensOut)} out</span>
    </div>
    <div class="ticker-line">
      <span class="tk-label">throughput</span>
      ${tickerBar(throughput, throughput, barWidth)}
      <span class="tk-val">${throughput.toLocaleString()}</span>
      <span class="tk-dim">tokens/sec</span>
    </div>
    <div class="duration-breakdown" id="dur-breakdown"></div>
  </div>

  <!-- Pulse Meter -->
  <div class="pulse-section">
    <div class="section-label">Token Consumption</div>
    ${buildPulseSvg(bars, totalMs, totalTokens)}
    <div class="pulse-legend">
      <span>0</span>
      <span>${totalTokens.toLocaleString()} tokens</span>
    </div>
  </div>

  <div class="section-label">Request Timeline</div>
  <div id="chart-container"></div>
  <div class="detail-cards-container" id="detail-cards"></div>

  <div class="waterfall-section">
    <div class="waterfall-title">Cumulative Tokens</div>
    <div id="waterfall-container"></div>
    <div class="waterfall-label">
      <span>0</span>
      <span>${totalTokens.toLocaleString()} tokens</span>
    </div>
  </div>

  <div class="tooltip" id="tooltip"></div>
  <footer>modiqo &middot; trace</footer>

  <script src="${d3ScriptUri}"></script>
  <script>
    const data = ${dataJson};
    const totalMs = ${totalMs};
    const totalTokens = ${totalTokens};

    // Read CSS custom properties for D3
    const cs = getComputedStyle(document.body);
    const gradSuccessStart = cs.getPropertyValue('--grad-success-start').trim();
    const gradSuccessEnd = cs.getPropertyValue('--grad-success-end').trim();
    const gradErrorStart = cs.getPropertyValue('--grad-error-start').trim();
    const gradErrorEnd = cs.getPropertyValue('--grad-error-end').trim();
    const wfStart = cs.getPropertyValue('--waterfall-start').trim();
    const wfEnd = cs.getPropertyValue('--waterfall-end').trim();
    const wfStroke = cs.getPropertyValue('--waterfall-stroke').trim();
    const borderColor = cs.getPropertyValue('--border').trim() || '#333';
    const fgDim = cs.getPropertyValue('--fg-dim').trim() || '#888';
    const successColor = cs.getPropertyValue('--success').trim();
    const errorColor = cs.getPropertyValue('--error').trim();

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
    function escapeHtml(s) {
      if (!s) return '';
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    const ROW_H = 36;
    const THINK_H = 22;
    const rows = [];
    data.forEach((bar, i) => {
      rows.push({ type: 'bar', bar: bar, idx: i });
      if (bar.thinking && bar.thinking.length > 0) {
        bar.thinking.forEach(t => {
          rows.push({ type: 'think', bar: bar, think: t, idx: i });
        });
      }
    });

    const tooltip = document.getElementById('tooltip');
    const chartContainer = document.getElementById('chart-container');
    const detailCards = document.getElementById('detail-cards');

    // Detail cards
    data.forEach((bar, idx) => {
      const card = document.createElement('div');
      card.className = 'detail-card';
      card.id = 'detail-' + idx;

      let h = '<div class="detail-grid">';
      h += '<div class="detail-metric"><div class="detail-metric-label">Duration</div><div class="detail-metric-value">' + fmtMs(bar.duration_ms) + '</div></div>';
      h += '<div class="detail-metric"><div class="detail-metric-label">Tokens In</div><div class="detail-metric-value in">' + bar.tokens_in.toLocaleString() + '</div></div>';
      h += '<div class="detail-metric"><div class="detail-metric-label">Tokens Out</div><div class="detail-metric-value out">' + bar.tokens_out.toLocaleString() + '</div></div>';
      h += '</div>';

      const inPct = bar.tokens_total > 0 ? (bar.tokens_in / bar.tokens_total) * 100 : 50;
      h += '<div class="token-split"><div class="token-split-in" style="width:' + inPct + '%"></div><div class="token-split-out" style="width:' + (100 - inPct) + '%"></div></div>';

      if (bar.tool_calls.length > 0) {
        h += '<div style="margin-top:12px"><div class="tool-calls-title">Tool Calls (' + bar.tool_calls.length + ')</div>';
        bar.tool_calls.forEach(tc => {
          const argsStr = Object.entries(tc.args).map(([k,v]) => k + '=' + JSON.stringify(v)).join(', ');
          h += '<div class="tool-call-row"><span class="tool-call-name">' + escapeHtml(tc.name) + '</span><span class="tool-call-args">' + escapeHtml(argsStr) + '</span></div>';
        });
        h += '</div>';
      }

      if (bar.thinking && bar.thinking.length > 0) {
        h += '<div style="margin-top:12px"><div class="tool-calls-title">Thinking (' + bar.thinking.length + ')</div>';
        bar.thinking.forEach(t => {
          const saved = t.source_tokens > 0 && t.result_tokens > 0 ? t.source_tokens - t.result_tokens : 0;
          h += '<div class="tool-call-row">';
          h += '<span class="tool-call-name" style="color:var(--accent)">' + (t.kind === 'read' ? 'read' : 'extract') + '</span>';
          h += '<span class="tool-call-args">@' + t.source_response + ' ' + escapeHtml(t.query);
          if (t.result_tokens > 0) h += '  [' + t.result_tokens.toLocaleString() + ' tk]';
          if (saved > 0) h += '  saved ' + saved.toLocaleString();
          if (t.variable_name) h += '  &rarr; $' + escapeHtml(t.variable_name);
          h += '</span></div>';
        });
        h += '</div>';
      }

      card.innerHTML = h;
      detailCards.appendChild(card);
    });

    // Duration breakdown
    const durBreakdown = document.getElementById('dur-breakdown');
    const colors = [successColor, 'var(--accent)', 'var(--orange)', '#a78bfa', '#f472b6'];
    data.forEach((bar, i) => {
      const seg = document.createElement('div');
      seg.className = 'duration-seg';
      seg.style.flex = bar.duration_ms;
      seg.style.background = bar.has_error ? errorColor : colors[i % colors.length];
      seg.title = '@' + bar.response_id + ': ' + fmtMs(bar.duration_ms);
      durBreakdown.appendChild(seg);
    });

    // D3 rendering
    function render() {
      chartContainer.innerHTML = '';
      document.getElementById('waterfall-container').innerHTML = '';

      const containerWidth = chartContainer.clientWidth;
      if (containerWidth < 100) return;

      const margin = {
        top: 12,
        right: 80,
        bottom: 32,
        left: Math.min(Math.max(containerWidth * 0.2, 120), 200)
      };
      const totalHeight = rows.reduce((s, r) => s + (r.type === 'bar' ? ROW_H : THINK_H), 0);
      const width = containerWidth - margin.left - margin.right;
      const height = totalHeight;

      const x = d3.scaleLinear().domain([0, totalMs]).range([0, width]);

      const svg = d3.select(chartContainer)
        .append('svg')
        .attr('width', containerWidth)
        .attr('height', height + margin.top + margin.bottom);

      const defs = svg.append('defs');

      const successGrad = defs.append('linearGradient').attr('id', 'grad-success')
        .attr('x1', '0%').attr('x2', '100%');
      successGrad.append('stop').attr('offset', '0%').attr('stop-color', gradSuccessStart);
      successGrad.append('stop').attr('offset', '100%').attr('stop-color', gradSuccessEnd);

      const errorGrad = defs.append('linearGradient').attr('id', 'grad-error')
        .attr('x1', '0%').attr('x2', '100%');
      errorGrad.append('stop').attr('offset', '0%').attr('stop-color', gradErrorStart);
      errorGrad.append('stop').attr('offset', '100%').attr('stop-color', gradErrorEnd);

      const wfGrad = defs.append('linearGradient').attr('id', 'grad-waterfall')
        .attr('x1', '0%').attr('y1', '100%').attr('x2', '0%').attr('y2', '0%');
      wfGrad.append('stop').attr('offset', '0%').attr('stop-color', wfStart);
      wfGrad.append('stop').attr('offset', '100%').attr('stop-color', wfEnd);

      const g = svg.append('g').attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

      const ticks = x.ticks(6);
      g.selectAll('.grid-line')
        .data(ticks)
        .enter()
        .append('line')
        .attr('class', 'grid-line')
        .attr('x1', d => x(d))
        .attr('x2', d => x(d))
        .attr('y1', 0)
        .attr('y2', height);

      let yPos = 0;
      rows.forEach(row => {
        if (row.type === 'bar') {
          const bar = row.bar;
          const rowG = g.append('g').attr('transform', 'translate(0,' + yPos + ')');

          rowG.append('rect')
            .attr('x', -margin.left)
            .attr('width', containerWidth)
            .attr('height', ROW_H)
            .attr('fill', 'transparent')
            .attr('class', 'bar-rect')
            .on('click', () => {
              const card = document.getElementById('detail-' + row.idx);
              if (card) card.classList.toggle('open');
            })
            .on('mousemove', (e) => {
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
            })
            .on('mouseout', () => { tooltip.style.display = 'none'; });

          rowG.append('line')
            .attr('x1', -margin.left).attr('x2', containerWidth - margin.left)
            .attr('y1', ROW_H).attr('y2', ROW_H)
            .attr('stroke', borderColor).attr('stroke-opacity', 0.15);

          rowG.append('text')
            .attr('class', 'label-text')
            .attr('x', -margin.left + 12)
            .attr('y', ROW_H / 2)
            .attr('dominant-baseline', 'central')
            .attr('text-anchor', 'start')
            .text('@' + bar.response_id);

          const methodMaxChars = Math.floor((margin.left - 60) / 7.5);
          const methodLabel = bar.method.length > methodMaxChars
            ? bar.method.slice(0, methodMaxChars) + '\u2026'
            : bar.method;
          rowG.append('text')
            .attr('class', 'method-text')
            .attr('x', -margin.left + 50)
            .attr('y', ROW_H / 2)
            .attr('dominant-baseline', 'central')
            .attr('text-anchor', 'start')
            .text(methodLabel);

          const bh = barHeight(bar.tokens_total);
          const bx = x(bar.start_offset_ms);
          const bw = Math.max(x(bar.start_offset_ms + bar.duration_ms) - bx, 6);
          const by = (ROW_H - bh) / 2;

          if (bar.tool_calls.length > 1) {
            const segW = bw / bar.tool_calls.length;
            bar.tool_calls.forEach((tc, si) => {
              rowG.append('rect')
                .attr('x', bx + si * segW)
                .attr('y', by)
                .attr('width', Math.max(segW - 1, 2))
                .attr('height', bh)
                .attr('rx', si === 0 ? 4 : 1)
                .attr('ry', si === 0 ? 4 : 1)
                .attr('fill', bar.has_error ? 'url(#grad-error)' : 'url(#grad-success)')
                .attr('opacity', 0.7 + (si % 2) * 0.3);
            });
            if (bar.tool_calls.length > 0) {
              const lastSeg = rowG.selectAll('rect').filter((_, i, nodes) => i === nodes.length - 1);
              lastSeg.attr('rx', 4).attr('ry', 4);
            }
          } else {
            rowG.append('rect')
              .attr('x', bx)
              .attr('y', by)
              .attr('width', bw)
              .attr('height', bh)
              .attr('rx', 4)
              .attr('ry', 4)
              .attr('fill', bar.has_error ? 'url(#grad-error)' : 'url(#grad-success)');
          }

          const metaX = bx + bw + 6;
          if (metaX + 80 < width) {
            rowG.append('text')
              .attr('class', 'meta-text')
              .attr('x', metaX)
              .attr('y', ROW_H / 2)
              .attr('dominant-baseline', 'central')
              .text(fmtMs(bar.duration_ms) + '  [' + fmtTokens(bar.tokens_total) + ']');
          }

          yPos += ROW_H;

        } else {
          const t = row.think;
          const tG = g.append('g').attr('transform', 'translate(0,' + yPos + ')');

          tG.append('line')
            .attr('x1', -margin.left).attr('x2', containerWidth - margin.left)
            .attr('y1', THINK_H).attr('y2', THINK_H)
            .attr('stroke', borderColor).attr('stroke-opacity', 0.08);

          let tx = 4;
          tG.append('text')
            .attr('class', 'think-text think-icon-text')
            .attr('x', tx).attr('y', THINK_H / 2)
            .attr('dominant-baseline', 'central')
            .text(t.kind === 'read' ? '\u25C7' : '\u25B7');
          tx += 16;

          tG.append('text')
            .attr('class', 'think-text')
            .attr('x', tx).attr('y', THINK_H / 2)
            .attr('dominant-baseline', 'central')
            .text('@' + t.source_response);
          tx += 30;

          const queryDisplay = t.query.length > 30 ? t.query.slice(0, 30) + '...' : t.query;
          tG.append('text')
            .attr('class', 'think-text')
            .attr('x', tx).attr('y', THINK_H / 2)
            .attr('dominant-baseline', 'central')
            .attr('opacity', 0.7)
            .text(queryDisplay);
          tx += Math.min(queryDisplay.length * 6.5, width * 0.4) + 10;

          if (t.result_tokens > 0) {
            tG.append('text')
              .attr('class', 'think-text')
              .attr('x', tx).attr('y', THINK_H / 2)
              .attr('dominant-baseline', 'central')
              .text('[' + fmtTokens(t.result_tokens) + 'tk]');
            tx += 60;
          }

          if (t.source_tokens > 0 && t.result_tokens > 0) {
            const saved = t.source_tokens - t.result_tokens;
            if (saved > 0) {
              tG.append('text')
                .attr('class', 'think-text think-saved-text')
                .attr('x', tx).attr('y', THINK_H / 2)
                .attr('dominant-baseline', 'central')
                .text('saved ' + saved.toLocaleString());
              tx += 70;
            }
          }

          if (t.variable_name) {
            tG.append('text')
              .attr('class', 'think-text think-var-text')
              .attr('x', tx).attr('y', THINK_H / 2)
              .attr('dominant-baseline', 'central')
              .text('$' + t.variable_name);
            tx += 60;
          }

          tG.append('text')
            .attr('class', 'think-text')
            .attr('x', tx).attr('y', THINK_H / 2)
            .attr('dominant-baseline', 'central')
            .attr('opacity', 0.35)
            .text('\u3008' + t.kind + '\u3009');

          yPos += THINK_H;
        }
      });

      // X axis
      const axisG = g.append('g').attr('transform', 'translate(0,' + height + ')');
      const xAxis = d3.axisBottom(x)
        .ticks(6)
        .tickFormat(d => fmtMs(d))
        .tickSize(6)
        .tickPadding(6);
      axisG.call(xAxis);
      axisG.selectAll('text').attr('class', 'axis-text');
      axisG.select('.domain').attr('stroke', borderColor).attr('stroke-opacity', 0.5);
      axisG.selectAll('.tick line').attr('stroke', borderColor).attr('stroke-opacity', 0.3);

      // Waterfall
      const wfContainer = document.getElementById('waterfall-container');
      const wfHeight = 60;
      const wfSvg = d3.select(wfContainer)
        .append('svg')
        .attr('width', containerWidth)
        .attr('height', wfHeight + 8);

      const wfG = wfSvg.append('g').attr('transform', 'translate(' + margin.left + ',4)');

      const wfData = [{ x: 0, y: 0 }];
      let cumulative = 0;
      data.forEach(bar => {
        wfData.push({ x: bar.start_offset_ms, y: cumulative });
        cumulative += bar.tokens_total;
        wfData.push({ x: bar.start_offset_ms + bar.duration_ms, y: cumulative });
      });
      wfData.push({ x: totalMs, y: cumulative });

      const yWf = d3.scaleLinear().domain([0, totalTokens]).range([wfHeight, 0]);

      const areaGen = d3.area()
        .x(d => x(d.x))
        .y0(wfHeight)
        .y1(d => yWf(d.y))
        .curve(d3.curveMonotoneX);

      wfG.append('path')
        .datum(wfData)
        .attr('d', areaGen)
        .attr('fill', 'url(#grad-waterfall)');

      wfG.append('path')
        .datum(wfData)
        .attr('d', d3.area().x(d => x(d.x)).y0(d => yWf(d.y)).y1(d => yWf(d.y)).curve(d3.curveMonotoneX))
        .attr('fill', 'none')
        .attr('stroke', wfStroke)
        .attr('stroke-width', 1.5)
        .attr('stroke-opacity', 0.6);

      wfG.append('rect')
        .attr('x', 0).attr('y', 0)
        .attr('width', width).attr('height', wfHeight)
        .attr('fill', 'none')
        .attr('stroke', borderColor)
        .attr('stroke-opacity', 0.3)
        .attr('rx', 6);
    }

    render();
    const ro = new ResizeObserver(() => render());
    ro.observe(chartContainer);
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
