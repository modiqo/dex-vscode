import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

interface WorkspaceInfo {
  name: string;
  dir: string;
}

interface QueryEntry {
  kind: "read" | "extract";
  sourceResponse: number;
  query: string;
  sourceTokens: number;
  resultTokens: number;
  variableName: string;
}

interface StatsData {
  queries: QueryEntry[];
  totalSourceTokens: number;
  totalResultTokens: number;
  reduction: number;
  reductionPct: number;
  executionMode: string;
}

export function showStatsPanel(
  extensionUri: vscode.Uri,
  ws: WorkspaceInfo
): void {
  const stateFile = path.join(ws.dir, ".dex", "state.json");
  if (!fs.existsSync(stateFile)) {
    vscode.window.showWarningMessage("No state.json found for this workspace.");
    return;
  }

  const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  const stats = buildStatsData(state);

  if (stats.queries.length === 0) {
    vscode.window.showInformationMessage("No query data available for stats.");
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "modiqo.stats",
    `Stats: ${ws.name}`,
    vscode.ViewColumn.One,
    { enableScripts: true }
  );

  panel.webview.html = buildStatsHtml(ws.name, stats);
}

function buildStatsData(
  state: {
    command_log: Array<{
      type: { command: string; params: Record<string, unknown> };
    }>;
    named_vars?: Record<string, string>;
  }
): StatsData {
  const queries: QueryEntry[] = [];
  const commandLog = state.command_log || [];

  for (const cmd of commandLog) {
    const cmdType = cmd.type.command;
    if (cmdType === "QueryRead" || cmdType === "QueryExtract") {
      const p = cmd.type.params;
      queries.push({
        kind: cmdType === "QueryRead" ? "read" : "extract",
        sourceResponse: (p.source_response as number) ?? 0,
        query: (p.query as string) ?? "",
        sourceTokens: (p.source_response_tokens as number) ?? 0,
        resultTokens: (p.result_tokens as number) ?? 0,
        variableName: (p.variable_name as string) ?? "",
      });
    }
  }

  const totalSourceTokens = queries.reduce((s, q) => s + q.sourceTokens, 0);
  const totalResultTokens = queries.reduce((s, q) => s + q.resultTokens, 0);
  const reduction = totalSourceTokens - totalResultTokens;
  const reductionPct = totalSourceTokens > 0
    ? Math.round((reduction / totalSourceTokens) * 100)
    : 0;

  const executionMode = state.named_vars?.execution_mode || "interactive";

  return {
    queries,
    totalSourceTokens,
    totalResultTokens,
    reduction,
    reductionPct,
    executionMode,
  };
}

// ── Terminal ticker bar builders ─────────────────────────────────

function tickerBar(value: number, max: number, width: number): string {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  const empty = width - filled;
  return `<span class="tk-fill">${"\u2588".repeat(filled)}</span><span class="tk-empty">${"\u2591".repeat(empty)}</span>`;
}

// ── Token River SVG (uses CSS vars via style attributes) ─────────

function buildRiverSvg(sourceTokens: number, resultTokens: number, reductionPct: number): string {
  // The river tapers from source (wide) to result (narrower)
  // Even 1% reduction shows visually
  const taperAmount = Math.max(reductionPct * 0.4, 2); // min 2px visible taper
  const topIn = 15;
  const botIn = 85;
  const topOut = topIn + taperAmount;
  const botOut = botIn - taperAmount;

  return `<svg viewBox="0 0 600 100" class="river-svg" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="river-outer" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" style="stop-color: var(--river-outer-start)"/>
        <stop offset="100%" style="stop-color: var(--river-outer-end)"/>
      </linearGradient>
      <linearGradient id="river-core" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" style="stop-color: var(--success)"/>
        <stop offset="100%" style="stop-color: var(--success-soft)"/>
      </linearGradient>
    </defs>
    <!-- Outer flow (full response) -->
    <path d="M0,${topIn} C200,${topIn} 400,${topOut} 600,${topOut}
             L600,${botOut} C400,${botOut} 200,${botIn} 0,${botIn} Z"
          style="fill: url(#river-outer); opacity: 0.35"/>
    <!-- Inner core (extracted) -->
    <path d="M0,${topIn + 2} C200,${topIn + 2} 400,${topOut + 1} 600,${topOut + 1}
             L600,${botOut - 1} C400,${botOut - 1} 200,${botIn - 2} 0,${botIn - 2} Z"
          style="fill: url(#river-core); opacity: 0.7"/>
    <!-- Flow lines (animated dashes) -->
    <path d="M0,50 C200,50 400,50 600,50" class="river-flow"
          style="fill: none; stroke: var(--success); stroke-width: 1; stroke-dasharray: 8 12; stroke-opacity: 0.5"/>
    <!-- Labels -->
    <text x="8" y="55" class="river-label river-label-in">${fmtTokensShort(sourceTokens)} in</text>
    <text x="592" y="55" text-anchor="end" class="river-label river-label-out">${fmtTokensShort(resultTokens)} out</text>
    ${reductionPct > 0 ? `<text x="300" y="16" text-anchor="middle" class="river-label river-label-delta">-${reductionPct}%</text>` : ""}
  </svg>`;
}

// ── Waffle Grid builder ──────────────────────────────────────────

function buildWaffleHtml(reductionPct: number): string {
  const savedCells = Math.max(Math.round(reductionPct), reductionPct > 0 ? 1 : 0);
  const extractedCells = 100 - savedCells;
  let cells = "";
  for (let i = 0; i < extractedCells; i++) {
    cells += `<div class="waffle-cell extracted"></div>`;
  }
  for (let i = 0; i < savedCells; i++) {
    cells += `<div class="waffle-cell saved"></div>`;
  }
  return cells;
}

// ── Compression Rune SVG ─────────────────────────────────────────

function buildRuneSvg(queryCount: number, reductionPct: number): string {
  // Generate a unique glyph: vertices = queries * 2 + 2, shape based on reduction
  const vertices = Math.max(queryCount * 2 + 2, 4);
  const outerR = 72;
  const innerR = outerR * (1 - reductionPct / 100);
  const cx = 90, cy = 90;

  function polygon(r: number, n: number, offset: number): string {
    const pts: string[] = [];
    for (let i = 0; i < n; i++) {
      const angle = (Math.PI * 2 * i) / n - Math.PI / 2 + offset;
      pts.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
    }
    return pts.join(" ");
  }

  return `<svg viewBox="0 0 180 180" class="rune-svg" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="rune-glow">
        <feGaussianBlur stdDeviation="3" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <polygon points="${polygon(outerR, vertices, 0)}" class="rune-outer"/>
    <polygon points="${polygon(innerR, vertices, 0.05)}" class="rune-inner" filter="url(#rune-glow)"/>
    <circle cx="${cx}" cy="${cy}" r="4" style="fill: var(--success)"/>
    <text x="${cx}" y="${cy + 1}" text-anchor="middle" dominant-baseline="central" class="rune-center">${queryCount}</text>
  </svg>`;
}

function buildStatsHtml(wsName: string, stats: StatsData): string {
  const isFlow = stats.executionMode === "flow";
  const modeLabel = isFlow ? "flow execution" : "interactive";
  const processedLabel = isFlow ? "processed" : "cached";
  const queriesJson = JSON.stringify(stats.queries);

  const contextWindow = 200000;
  const fullPct = stats.totalSourceTokens > 0
    ? ((stats.totalSourceTokens / contextWindow) * 100).toFixed(1)
    : "0";
  const resultPct = stats.totalResultTokens > 0
    ? ((stats.totalResultTokens / contextWindow) * 100).toFixed(1)
    : "0";
  const costSaved = ((stats.reduction / 1_000_000) * 3).toFixed(2);
  const showContextImpact = !isFlow && stats.reductionPct > 5;

  const maxTokenVal = Math.max(stats.totalSourceTokens, stats.totalResultTokens, 1);
  const barWidth = 32;

  const readCount = stats.queries.filter(q => q.kind === "read").length;
  const extractCount = stats.queries.filter(q => q.kind === "extract").length;

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

  /* Theme-adaptive custom colors */
  body.vscode-dark, body.vscode-high-contrast {
    --success: #4ec9b0;
    --success-soft: rgba(78,201,176,0.5);
    --error: #f14c4c;
    --orange: #E87A2A;
    --river-outer-start: rgba(232,122,42,0.4);
    --river-outer-end: rgba(232,122,42,0.15);
    --waffle-ext: rgba(78,201,176,0.55);
    --waffle-saved: var(--accent);
    --waffle-saved-glow: rgba(78,130,220,0.6);
    --rune-outer-stroke: rgba(232,122,42,0.3);
    --rune-inner-stroke: #4ec9b0;
    --ticker-bg: rgba(255,255,255,0.03);
    --context-row-border: rgba(128,128,128,0.15);
  }

  body.vscode-light {
    --success: #16825d;
    --success-soft: rgba(22,130,93,0.35);
    --error: #cd3131;
    --orange: #c05621;
    --river-outer-start: rgba(192,86,33,0.25);
    --river-outer-end: rgba(192,86,33,0.08);
    --waffle-ext: rgba(22,130,93,0.45);
    --waffle-saved: var(--accent);
    --waffle-saved-glow: rgba(0,90,180,0.4);
    --rune-outer-stroke: rgba(192,86,33,0.35);
    --rune-inner-stroke: #16825d;
    --ticker-bg: rgba(0,0,0,0.03);
    --context-row-border: rgba(0,0,0,0.08);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--fg);
    background: var(--bg);
    padding: 24px 32px;
    line-height: 1.5;
  }

  /* ── Header ────────────────────── */
  .header { margin-bottom: 28px; }
  .header h1 {
    font-size: 1.3em; font-weight: 600;
    font-family: var(--vscode-font-family);
  }
  .header .subtitle {
    color: var(--fg-dim); font-size: 0.85em; margin-top: 4px;
  }
  .mode-badge {
    display: inline-block; font-size: 0.7em; padding: 2px 8px;
    border-radius: 4px; margin-left: 8px; vertical-align: middle;
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--accent); font-weight: 500; letter-spacing: 0.04em;
  }

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
  .tk-empty { color: var(--border); opacity: 0.5; }
  .tk-val {
    color: var(--fg);
    font-weight: 600;
    margin-left: 4px;
    min-width: 8ch;
    text-align: right;
  }
  .tk-dim {
    color: var(--fg-dim);
    font-size: 0.9em;
  }

  /* ── River ─────────────────────── */
  .river-section { margin-bottom: 28px; }
  .section-label {
    font-size: 0.68em; text-transform: uppercase;
    letter-spacing: 0.1em; color: var(--fg-dim);
    margin-bottom: 10px;
  }
  .river-svg { width: 100%; height: auto; }
  .river-label {
    font-family: var(--mono);
    font-size: 11px;
  }
  .river-label-in { fill: var(--orange); }
  .river-label-out { fill: var(--success); }
  .river-label-delta { fill: var(--fg-dim); font-size: 10px; }
  .river-flow {
    animation: flow-dash 3s linear infinite;
  }
  @keyframes flow-dash {
    from { stroke-dashoffset: 40; }
    to { stroke-dashoffset: 0; }
  }

  /* ── Waffle + Rune (side by side) */
  .viz-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 32px;
    align-items: start;
    margin-bottom: 28px;
  }
  .waffle-section { flex: 1; }
  .waffle-grid {
    display: grid;
    grid-template-columns: repeat(10, 1fr);
    gap: 3px;
    max-width: 260px;
  }
  .waffle-cell {
    aspect-ratio: 1;
    border-radius: 2px;
    transition: opacity 0.2s;
  }
  .waffle-cell.extracted {
    background: var(--waffle-ext);
  }
  .waffle-cell.saved {
    background: var(--waffle-saved);
    box-shadow: 0 0 8px var(--waffle-saved-glow);
  }
  .waffle-cell:hover { opacity: 0.8; }
  .waffle-legend {
    display: flex; gap: 16px; margin-top: 10px;
    font-size: 0.72em; color: var(--fg-dim);
  }
  .legend-dot {
    display: inline-block; width: 8px; height: 8px;
    border-radius: 2px; margin-right: 6px; vertical-align: middle;
  }

  .rune-container { text-align: center; }
  .rune-svg { width: 140px; height: 140px; }
  .rune-outer {
    fill: none;
    stroke: var(--rune-outer-stroke);
    stroke-width: 1.5;
    animation: rune-spin 60s linear infinite;
    transform-origin: 90px 90px;
  }
  .rune-inner {
    fill: none;
    stroke: var(--rune-inner-stroke);
    stroke-width: 2;
  }
  .rune-center {
    font-family: var(--mono);
    font-size: 14px;
    font-weight: 700;
    fill: var(--fg);
  }
  @keyframes rune-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  .rune-caption {
    font-size: 0.68em; color: var(--fg-dim);
    text-transform: uppercase; letter-spacing: 0.08em;
    margin-top: 8px;
  }

  /* ── Context Impact ────────────── */
  .context-section {
    background: var(--ticker-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 18px 22px;
    margin-bottom: 28px;
  }
  .context-row {
    display: flex; justify-content: space-between;
    align-items: center; padding: 8px 0;
    border-bottom: 1px solid var(--context-row-border);
    font-size: 0.85em;
  }
  .context-row:last-child { border-bottom: none; }
  .context-label { color: var(--fg-dim); }
  .context-value {
    font-family: var(--mono);
    font-weight: 600; font-variant-numeric: tabular-nums;
  }
  .context-value.highlight { color: var(--success); }
  .cost-savings {
    margin-top: 14px; padding: 10px 16px;
    background: color-mix(in srgb, var(--success) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--success) 20%, transparent);
    border-radius: 6px; font-size: 0.85em;
    color: var(--success); font-weight: 500;
  }

  /* ── Query Breakdown ───────────── */
  .breakdown-section { margin-bottom: 28px; }
  .query-row {
    display: flex; align-items: center; gap: 10px;
    padding: 7px 12px; font-size: 0.82em;
    border-bottom: 1px solid var(--context-row-border);
  }
  .query-row:last-child { border-bottom: none; }
  .query-kind {
    font-size: 0.72em; padding: 1px 6px;
    border-radius: 3px; font-weight: 500; flex-shrink: 0;
  }
  .query-kind.read {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--accent);
  }
  .query-kind.extract {
    background: color-mix(in srgb, var(--orange) 15%, transparent);
    color: var(--orange);
  }
  .query-source {
    font-family: var(--mono); font-size: 0.85em;
    color: var(--fg-dim); flex-shrink: 0;
  }
  .query-text {
    flex: 1; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; color: var(--fg);
  }
  .query-tokens {
    font-family: var(--mono); font-size: 0.85em;
    color: var(--fg-dim); flex-shrink: 0;
  }
  .query-saved {
    font-family: var(--mono); font-size: 0.85em;
    color: var(--success); font-weight: 500; flex-shrink: 0;
  }
  .query-var {
    font-family: var(--mono); font-size: 0.85em;
    color: var(--orange); flex-shrink: 0;
  }

  .note {
    font-size: 0.78em; color: var(--fg-dim);
    margin-bottom: 20px; font-style: italic;
  }

  footer { margin-top: 24px; font-size: 0.72em; color: var(--fg-dim); }
</style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(wsName)}</h1>
    <div class="subtitle">
      ${stats.queries.length} ${stats.queries.length === 1 ? "query" : "queries"} &middot; ${modeLabel}
      <span class="mode-badge">${isFlow ? "flow" : "interactive"}</span>
    </div>
  </div>

  <!-- Terminal Ticker -->
  <div class="ticker">
    <div class="ticker-line">
      <span class="tk-label">queries</span>
      ${tickerBar(stats.queries.length, Math.max(stats.queries.length, 10), barWidth)}
      <span class="tk-val">${stats.queries.length}</span>
      <span class="tk-dim">${readCount} read &middot; ${extractCount} extract</span>
    </div>
    <div class="ticker-line">
      <span class="tk-label">response</span>
      ${tickerBar(stats.totalSourceTokens, maxTokenVal, barWidth)}
      <span class="tk-val">${fmtTokensShort(stats.totalSourceTokens)}</span>
      <span class="tk-dim">tokens ${processedLabel}</span>
    </div>
    <div class="ticker-line">
      <span class="tk-label">extracted</span>
      ${tickerBar(stats.totalResultTokens, maxTokenVal, barWidth)}
      <span class="tk-val">${fmtTokensShort(stats.totalResultTokens)}</span>
      <span class="tk-dim">tokens extracted</span>
    </div>
    <div class="ticker-line">
      <span class="tk-label">reduction</span>
      ${tickerBar(stats.reductionPct, 100, barWidth)}
      <span class="tk-val">${stats.reductionPct}%</span>
      <span class="tk-dim">${stats.reduction.toLocaleString()} saved</span>
    </div>
  </div>

  <!-- Token River -->
  <div class="river-section">
    <div class="section-label">Token Flow</div>
    ${buildRiverSvg(stats.totalSourceTokens, stats.totalResultTokens, stats.reductionPct)}
  </div>

  <!-- Waffle Grid + Compression Rune -->
  <div class="viz-row">
    <div class="waffle-section">
      <div class="section-label">Reduction Map</div>
      <div class="waffle-grid">
        ${buildWaffleHtml(stats.reductionPct)}
      </div>
      <div class="waffle-legend">
        <span><span class="legend-dot" style="background: var(--waffle-ext)"></span>extracted</span>
        <span><span class="legend-dot" style="background: var(--waffle-saved)"></span>saved</span>
      </div>
    </div>
    <div class="rune-container">
      <div class="section-label">Session Glyph</div>
      ${buildRuneSvg(stats.queries.length, stats.reductionPct)}
      <div class="rune-caption">${stats.queries.length} queries &middot; ${stats.reductionPct}% reduced</div>
    </div>
  </div>

  ${showContextImpact ? `
  <div class="context-section">
    <div class="section-label">Context Window Impact</div>
    <div class="context-row">
      <span class="context-label">Full responses</span>
      <span class="context-value">${fullPct}% of 200K context</span>
    </div>
    <div class="context-row">
      <span class="context-label">Query results only</span>
      <span class="context-value highlight">${resultPct}% of 200K context</span>
    </div>
    <div class="cost-savings">
      ~$${costSaved} saved per invocation (Sonnet 4.5 at $3/M input tokens)
    </div>
  </div>
  ` : ""}

  <div class="breakdown-section">
    <div class="section-label">Query Breakdown</div>
    <div id="query-list"></div>
  </div>

  <div class="note">
    ${isFlow
      ? "Flow execution &mdash; responses processed locally, tokens represent data volume"
      : "Token counts via tiktoken &mdash; actual billing depends on model and provider"}
  </div>

  <footer>modiqo &middot; dex stats</footer>

  <script>
    const queries = ${queriesJson};
    const list = document.getElementById('query-list');

    queries.forEach(q => {
      const row = document.createElement('div');
      row.className = 'query-row';

      const saved = q.sourceTokens > 0 && q.resultTokens > 0 ? q.sourceTokens - q.resultTokens : 0;
      const queryDisplay = q.query.length > 50 ? q.query.slice(0, 50) + '...' : q.query;

      let html = '';
      html += '<span class="query-kind ' + q.kind + '">' + q.kind + '</span>';
      html += '<span class="query-source">@' + q.sourceResponse + '</span>';
      html += '<span class="query-text">' + escapeHtml(queryDisplay) + '</span>';
      if (q.resultTokens > 0) {
        html += '<span class="query-tokens">' + q.resultTokens.toLocaleString() + ' tk</span>';
      }
      if (saved > 0) {
        html += '<span class="query-saved">-' + saved.toLocaleString() + '</span>';
      }
      if (q.variableName) {
        html += '<span class="query-var">$' + escapeHtml(q.variableName) + '</span>';
      }

      row.innerHTML = html;
      list.appendChild(row);
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

function fmtTokensShort(n: number): string {
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
  if (n >= 1_000) { return `${Math.round(n / 1000)}K`; }
  return n.toString();
}
