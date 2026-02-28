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

function buildStatsHtml(wsName: string, stats: StatsData): string {
  const isFlow = stats.executionMode === "flow";
  const modeLabel = isFlow ? "flow execution" : "interactive";
  const processedLabel = isFlow ? "processed" : "cached";
  const queriesJson = JSON.stringify(stats.queries);

  // Context window analysis (interactive mode)
  const contextWindow = 200000;
  const fullPct = stats.totalSourceTokens > 0
    ? ((stats.totalSourceTokens / contextWindow) * 100).toFixed(1)
    : "0";
  const resultPct = stats.totalResultTokens > 0
    ? ((stats.totalResultTokens / contextWindow) * 100).toFixed(1)
    : "0";

  // Cost estimate (Sonnet 4.5: $3/M input)
  const costSaved = ((stats.reduction / 1_000_000) * 3).toFixed(2);

  const successPct = stats.queries.length > 0 ? 100 : 0;
  const extractedRatio = stats.totalSourceTokens > 0
    ? Math.round((stats.totalResultTokens / stats.totalSourceTokens) * 100)
    : 0;

  const showContextImpact = !isFlow && stats.reductionPct > 5;

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
    --orange: #E87A2A;
    --mono: var(--vscode-editor-font-family, 'SF Mono', 'Fira Code', monospace);
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
  .header .mode-badge {
    display: inline-block;
    font-size: 0.7em;
    padding: 2px 8px;
    border-radius: 4px;
    margin-left: 8px;
    vertical-align: middle;
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--accent);
    font-weight: 500;
    letter-spacing: 0.04em;
  }

  /* Stat cards */
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
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

  .stat-card.queries::before { background: var(--accent); }
  .stat-card.source::before { background: var(--orange); }
  .stat-card.result::before { background: var(--success); }
  .stat-card.reduction::before { background: linear-gradient(90deg, var(--success), var(--accent)); }

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

  .success-ring {
    width: 36px; height: 36px; border-radius: 50%;
    position: absolute; right: 16px; top: 50%; transform: translateY(-50%);
  }
  .success-ring-hole {
    width: 22px; height: 22px; border-radius: 50%;
    background: var(--card-bg);
    position: absolute; top: 7px; left: 7px;
    display: flex; align-items: center; justify-content: center;
    font-size: 0.55em; font-weight: 700; color: var(--success);
  }

  /* Efficiency bar */
  .efficiency-section {
    margin-bottom: 32px;
  }

  .efficiency-title {
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--fg-dim);
    margin-bottom: 12px;
  }

  .efficiency-bar-container {
    position: relative;
    height: 40px;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }

  .efficiency-bar-full {
    position: absolute;
    top: 0; left: 0; bottom: 0;
    width: 100%;
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    display: flex;
    align-items: center;
    padding: 0 14px;
  }

  .efficiency-bar-extracted {
    position: absolute;
    top: 0; left: 0; bottom: 0;
    background: linear-gradient(90deg, color-mix(in srgb, var(--success) 35%, transparent), color-mix(in srgb, var(--success) 20%, transparent));
    border-right: 2px solid var(--success);
    display: flex;
    align-items: center;
    padding: 0 14px;
    min-width: 60px;
  }

  .efficiency-label {
    font-size: 0.72em;
    font-weight: 500;
    white-space: nowrap;
  }

  .efficiency-label.full { color: var(--fg-dim); position: absolute; right: 14px; }
  .efficiency-label.extracted { color: var(--success); }

  .efficiency-legend {
    display: flex;
    gap: 20px;
    margin-top: 10px;
    font-size: 0.72em;
    color: var(--fg-dim);
  }

  .legend-dot {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
    margin-right: 6px;
    vertical-align: middle;
  }

  /* Context impact */
  .context-section {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px 24px;
    margin-bottom: 32px;
  }

  .context-title {
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--fg-dim);
    margin-bottom: 14px;
  }

  .context-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 30%, transparent);
  }

  .context-row:last-child { border-bottom: none; }

  .context-label { font-size: 0.85em; color: var(--fg-dim); }
  .context-value {
    font-family: var(--mono);
    font-size: 0.9em;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .context-value.highlight { color: var(--success); }

  .cost-savings {
    margin-top: 14px;
    padding: 10px 16px;
    background: color-mix(in srgb, var(--success) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--success) 20%, transparent);
    border-radius: 6px;
    font-size: 0.85em;
    color: var(--success);
    font-weight: 500;
  }

  /* Query breakdown */
  .breakdown-section { margin-bottom: 32px; }

  .breakdown-title {
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--fg-dim);
    margin-bottom: 12px;
  }

  .query-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 20%, transparent);
    font-size: 0.82em;
  }

  .query-row:last-child { border-bottom: none; }

  .query-kind {
    font-size: 0.75em;
    padding: 1px 6px;
    border-radius: 3px;
    font-weight: 500;
    flex-shrink: 0;
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
    font-family: var(--mono);
    font-size: 0.9em;
    color: var(--fg-dim);
    flex-shrink: 0;
  }

  .query-text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg);
  }

  .query-tokens {
    font-family: var(--mono);
    font-size: 0.85em;
    color: var(--fg-dim);
    flex-shrink: 0;
  }

  .query-saved {
    font-family: var(--mono);
    font-size: 0.85em;
    color: var(--success);
    font-weight: 500;
    flex-shrink: 0;
  }

  .query-var {
    font-family: var(--mono);
    font-size: 0.85em;
    color: var(--orange);
    flex-shrink: 0;
  }

  .note {
    font-size: 0.78em;
    color: var(--fg-dim);
    margin-bottom: 20px;
    font-style: italic;
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

  <div class="stats">
    <div class="stat-card queries">
      <div class="stat-label">Queries</div>
      <div class="stat-value">${stats.queries.length}</div>
      <div class="stat-sub">${stats.queries.filter(q => q.kind === "read").length} read &middot; ${stats.queries.filter(q => q.kind === "extract").length} extract</div>
      <div class="success-ring" style="background: conic-gradient(var(--success) ${successPct * 3.6}deg, var(--border) 0deg);">
        <div class="success-ring-hole">${successPct}%</div>
      </div>
    </div>
    <div class="stat-card source">
      <div class="stat-label">Response Data</div>
      <div class="stat-value">${stats.totalSourceTokens.toLocaleString()}</div>
      <div class="stat-sub">tokens ${processedLabel}</div>
    </div>
    <div class="stat-card result">
      <div class="stat-label">Results Extracted</div>
      <div class="stat-value">${stats.totalResultTokens.toLocaleString()}</div>
      <div class="stat-sub">tokens extracted</div>
    </div>
    <div class="stat-card reduction">
      <div class="stat-label">Reduction</div>
      <div class="stat-value">${stats.reductionPct}%</div>
      <div class="stat-sub">${stats.reduction.toLocaleString()} tokens saved</div>
      <div class="success-ring" style="background: conic-gradient(var(--success) ${stats.reductionPct * 3.6}deg, var(--border) 0deg);">
        <div class="success-ring-hole">${stats.reductionPct}%</div>
      </div>
    </div>
  </div>

  <div class="efficiency-section">
    <div class="efficiency-title">Token Efficiency</div>
    <div class="efficiency-bar-container">
      <div class="efficiency-bar-full">
        <span class="efficiency-label full">${stats.totalSourceTokens.toLocaleString()} ${processedLabel}</span>
      </div>
      <div class="efficiency-bar-extracted" style="width: ${Math.max(extractedRatio, 3)}%">
        <span class="efficiency-label extracted">${stats.totalResultTokens.toLocaleString()}</span>
      </div>
    </div>
    <div class="efficiency-legend">
      <span><span class="legend-dot" style="background: var(--success)"></span>extracted</span>
      <span><span class="legend-dot" style="background: color-mix(in srgb, var(--accent) 30%, transparent)"></span>${processedLabel}</span>
    </div>
  </div>

  ${showContextImpact ? `
  <div class="context-section">
    <div class="context-title">Context Window Impact</div>
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
    <div class="breakdown-title">Query Breakdown</div>
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
