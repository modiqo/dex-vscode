import * as vscode from "vscode";
import type { ExploreResult } from "../client/dexClient";

export function showExploreResultsPanel(
  extensionUri: vscode.Uri,
  result: ExploreResult
): void {
  const panel = vscode.window.createWebviewPanel(
    "modiqo.exploreResults",
    `Explore: ${result.query}`,
    vscode.ViewColumn.One,
    { enableScripts: true }
  );

  panel.webview.html = buildExploreHtml(result);
}

function buildExploreHtml(result: ExploreResult): string {
  const toolsJson = JSON.stringify(result.tools);
  const skillsJson = JSON.stringify(result.skills);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  ${sharedCss()}

  .query-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 28px;
  }

  .query-icon {
    font-size: 1.1em;
    color: var(--accent);
  }

  .query-text {
    font-size: 0.95em;
    color: var(--fg);
    font-style: italic;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
    margin-top: 32px;
  }

  .section-header h2 {
    font-size: 1.05em;
    font-weight: 600;
  }

  .section-header .count {
    font-size: 0.78em;
    color: var(--fg-dim);
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 2px 10px;
  }

  /* Skill cards */
  .skill-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 10px;
    margin-bottom: 12px;
  }

  .skill-card {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 18px;
    background: var(--card-bg);
    transition: border-color 0.15s;
  }

  .skill-card:hover {
    border-color: var(--accent);
  }

  .skill-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }

  .skill-name {
    font-weight: 600;
    font-size: 0.92em;
  }

  .match-badge {
    font-size: 0.72em;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 10px;
    white-space: nowrap;
  }

  .match-high {
    background: color-mix(in srgb, var(--success) 18%, transparent);
    color: var(--success);
  }

  .match-mid {
    background: color-mix(in srgb, #e8a317 18%, transparent);
    color: #e8a317;
  }

  .match-low {
    background: color-mix(in srgb, var(--fg-dim) 15%, transparent);
    color: var(--fg-dim);
  }

  .skill-desc {
    font-size: 0.82em;
    color: var(--fg-dim);
    line-height: 1.5;
    margin-bottom: 8px;
  }

  .score-bar-container {
    height: 4px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
  }

  .score-bar {
    height: 100%;
    border-radius: 2px;
    transition: width 0.4s ease;
  }

  /* Adapter groups */
  .adapter-group {
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 12px;
    overflow: hidden;
    background: var(--card-bg);
  }

  .adapter-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 18px;
    background: color-mix(in srgb, var(--accent) 6%, var(--card-bg));
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    user-select: none;
  }

  .adapter-header:hover {
    background: color-mix(in srgb, var(--accent) 12%, var(--card-bg));
  }

  .adapter-name {
    font-weight: 600;
    font-size: 0.95em;
  }

  .adapter-meta {
    font-size: 0.75em;
    color: var(--fg-dim);
  }

  .adapter-tools {
    padding: 0;
  }

  .tool-row {
    display: flex;
    align-items: center;
    padding: 8px 18px;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
    font-size: 0.85em;
    gap: 12px;
  }

  .tool-row:last-child {
    border-bottom: none;
  }

  .tool-name {
    font-family: var(--mono);
    font-weight: 500;
    min-width: 180px;
    flex-shrink: 0;
  }

  .tool-toolset {
    font-size: 0.8em;
    color: var(--fg-dim);
    min-width: 100px;
    flex-shrink: 0;
  }

  .tool-desc {
    flex: 1;
    color: var(--fg-dim);
    font-size: 0.9em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tool-score {
    min-width: 120px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .tool-score-bar {
    flex: 1;
    height: 6px;
    background: var(--border);
    border-radius: 3px;
    overflow: hidden;
  }

  .tool-score-fill {
    height: 100%;
    border-radius: 3px;
  }

  .tool-score-label {
    font-size: 0.8em;
    font-weight: 600;
    min-width: 32px;
    text-align: right;
  }

  .empty-state {
    text-align: center;
    padding: 40px 20px;
    color: var(--fg-dim);
    font-size: 0.9em;
  }

  .group-tag {
    font-size: 0.68em;
    padding: 1px 6px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--accent);
    margin-left: 8px;
  }
</style>
</head>
<body>
  <div class="header">
    <h1>Explore</h1>
    <div class="subtitle">Adapter and flow discovery</div>
  </div>

  <div class="query-bar">
    <span class="query-icon">&#x1F50D;</span>
    <span class="query-text">"${escapeHtml(result.query)}"</span>
  </div>

  <div id="skills-section"></div>
  <div id="adapters-section"></div>

  <footer>modiqo &middot; explore</footer>

  <script>
    const tools = ${toolsJson};
    const skills = ${skillsJson};

    function escapeHtml(s) {
      if (!s) return '';
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function scoreColor(score) {
      if (score >= 70) return 'var(--success)';
      if (score >= 40) return '#e8a317';
      return 'var(--fg-dim)';
    }

    function matchClass(pct) {
      const num = parseInt(pct, 10) || 0;
      if (num >= 70) return 'match-high';
      if (num >= 40) return 'match-mid';
      return 'match-low';
    }

    function parseMatchPct(s) {
      return parseInt(s, 10) || 0;
    }

    // ── Skills section ──
    const skillsEl = document.getElementById('skills-section');
    if (skills.length > 0) {
      let html = '<div class="section-header"><h2>Flows</h2><span class="count">' + skills.length + ' matches</span></div>';
      html += '<div class="skill-cards">';
      skills.forEach(s => {
        const pct = parseMatchPct(s.matchPercent);
        const cls = matchClass(s.matchPercent);
        html += '<div class="skill-card">';
        html += '<div class="skill-top">';
        html += '<span class="skill-name">' + escapeHtml(s.name) + '</span>';
        html += '<span class="match-badge ' + cls + '">' + escapeHtml(s.matchPercent) + '</span>';
        html += '</div>';
        html += '<div class="skill-desc">' + escapeHtml(s.description) + '</div>';
        html += '<div class="score-bar-container"><div class="score-bar" style="width:' + pct + '%;background:' + scoreColor(pct / 100) + '"></div></div>';
        html += '</div>';
      });
      html += '</div>';
      skillsEl.innerHTML = html;
    }

    // ── Adapters section (grouped) ──
    const adaptersEl = document.getElementById('adapters-section');
    if (tools.length > 0) {
      // Group by adapter_id
      const groups = {};
      tools.forEach(t => {
        if (!groups[t.adapter_id]) groups[t.adapter_id] = [];
        groups[t.adapter_id].push(t);
      });

      // Sort groups by best score
      const sorted = Object.entries(groups).sort((a, b) => {
        const bestA = Math.max(...a[1].map(t => t.score));
        const bestB = Math.max(...b[1].map(t => t.score));
        return bestB - bestA;
      });

      let html = '<div class="section-header"><h2>Adapters</h2><span class="count">' + sorted.length + ' adapters, ' + tools.length + ' tools</span></div>';

      sorted.forEach(([adapterId, adapterTools]) => {
        adapterTools.sort((a, b) => b.score - a.score);
        const bestScore = Math.round(adapterTools[0].score);
        const group = adapterTools[0].group || '';

        html += '<div class="adapter-group">';
        html += '<div class="adapter-header" onclick="this.parentElement.classList.toggle(\'collapsed\')">';
        html += '<span><span class="adapter-name">' + escapeHtml(adapterId) + '</span>';
        if (group) html += '<span class="group-tag">' + escapeHtml(group) + '</span>';
        html += '</span>';
        html += '<span class="adapter-meta">' + adapterTools.length + ' tools, best ' + bestScore + '%</span>';
        html += '</div>';
        html += '<div class="adapter-tools">';

        adapterTools.forEach(t => {
          const pct = Math.round(t.score);
          html += '<div class="tool-row">';
          html += '<span class="tool-name">' + escapeHtml(t.tool) + '</span>';
          html += '<span class="tool-toolset">' + escapeHtml(t.toolset) + '</span>';
          html += '<span class="tool-desc">' + escapeHtml(t.description) + '</span>';
          html += '<span class="tool-score">';
          html += '<span class="tool-score-bar"><span class="tool-score-fill" style="width:' + pct + '%;background:' + scoreColor(t.score) + '"></span></span>';
          html += '<span class="tool-score-label" style="color:' + scoreColor(t.score) + '">' + pct + '%</span>';
          html += '</span>';
          html += '</div>';
        });

        html += '</div>';
        html += '</div>';
      });

      adaptersEl.innerHTML = html;
    }

    if (skills.length === 0 && tools.length === 0) {
      document.getElementById('skills-section').innerHTML = '<div class="empty-state">No results found for this query. Try a different search term.</div>';
    }
  </script>
</body>
</html>`;
}

function sharedCss(): string {
  return `
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

  .header { margin-bottom: 24px; }
  .header h1 { font-size: 1.4em; font-weight: 600; }
  .header .subtitle { color: var(--fg-dim); font-size: 0.9em; margin-top: 4px; }

  .adapter-group.collapsed .adapter-tools { display: none; }

  footer {
    margin-top: 28px;
    font-size: 0.72em;
    color: var(--fg-dim);
  }
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
