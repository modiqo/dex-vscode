import * as vscode from "vscode";
import type { DexClient, ExploreResult } from "../client/dexClient";

export class ExploreViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "modiqo-explore";

  private view?: vscode.WebviewView;
  private extensionUri: vscode.Uri;
  public cachedResult: ExploreResult | null = null;

  constructor(
    private client: DexClient,
    extensionUri: vscode.Uri,
  ) {
    this.extensionUri = extensionUri;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "search") {
        await this.handleSearch(msg.query);
      } else if (msg.type === "focus-adapters") {
        vscode.commands.executeCommand("modiqo-adapters.focus");
      } else if (msg.type === "focus-flows") {
        vscode.commands.executeCommand("modiqo-flows.focus");
      } else if (msg.type === "show-results-panel") {
        if (this.cachedResult) {
          const { showExploreResultsPanel } = await import("../panels/explorePanel");
          showExploreResultsPanel(this.extensionUri, this.cachedResult);
        }
      }
    });
  }

  refresh(): void {
    this.cachedResult = null;
    if (this.view) {
      this.view.webview.html = this.getHtml();
    }
  }

  async search(query: string): Promise<void> {
    if (!this.view) { return; }
    this.view.webview.postMessage({ type: "loading" });

    try {
      this.cachedResult = await this.client.explore(query);
      this.view.webview.postMessage({ type: "results", result: this.cachedResult });
    } catch {
      this.cachedResult = { query, tools: [], skills: [], flowSearchResults: [] };
      this.view.webview.postMessage({ type: "results", result: this.cachedResult });
    }
  }

  private async handleSearch(query: string): Promise<void> {
    if (!this.view) { return; }
    this.view.webview.postMessage({ type: "loading" });

    try {
      this.cachedResult = await this.client.explore(query);
      this.view.webview.postMessage({ type: "results", result: this.cachedResult });
    } catch {
      this.cachedResult = { query, tools: [], skills: [], flowSearchResults: [] };
      this.view.webview.postMessage({ type: "results", result: this.cachedResult });
    }
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root {
    --fg: var(--vscode-foreground);
    --fg-dim: var(--vscode-descriptionForeground);
    --bg: var(--vscode-sideBar-background);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, transparent);
    --input-placeholder: var(--vscode-input-placeholderForeground);
    --border: var(--vscode-widget-border, #333);
    --hover: var(--vscode-list-hoverBackground);
    --accent: var(--vscode-textLink-foreground);
    --badge-bg: var(--vscode-badge-background);
    --badge-fg: var(--vscode-badge-foreground);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--fg);
    background: var(--bg);
    padding: 8px;
    line-height: 1.5;
  }

  .search-box {
    position: sticky;
    top: 0;
    background: var(--bg);
    padding-bottom: 8px;
    z-index: 10;
  }

  .search-input {
    width: 100%;
    padding: 6px 10px;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: 4px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    outline: none;
  }

  .search-input::placeholder { color: var(--input-placeholder); }
  .search-input:focus { border-color: var(--vscode-focusBorder); }

  .hint {
    color: var(--fg-dim);
    font-size: 0.85em;
    padding: 4px 2px 0;
  }

  .empty-state {
    text-align: center;
    padding: 24px 12px;
    color: var(--fg-dim);
    font-size: 0.9em;
    line-height: 1.6;
  }

  .empty-state .icon { font-size: 2em; margin-bottom: 8px; opacity: 0.5; }

  .loading {
    text-align: center;
    padding: 20px;
    color: var(--fg-dim);
    font-size: 0.85em;
  }

  .spinner {
    display: inline-block;
    width: 14px; height: 14px;
    border: 2px solid var(--fg-dim);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    vertical-align: middle;
    margin-right: 6px;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .section-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 2px 4px;
    font-size: 0.8em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fg-dim);
    cursor: pointer;
  }

  .section-header:hover { color: var(--fg); }

  .section-header .codicon {
    font-family: codicon;
    font-size: 14px;
  }

  .result-item {
    display: flex;
    flex-direction: column;
    padding: 5px 8px;
    border-radius: 4px;
    cursor: pointer;
    border-bottom: 1px solid var(--border);
  }

  .result-item:last-child { border-bottom: none; }
  .result-item:hover { background: var(--hover); }

  .result-name {
    font-weight: 500;
    font-size: 0.9em;
    color: var(--fg);
  }

  .result-meta {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 0.8em;
    color: var(--fg-dim);
    margin-top: 1px;
  }

  .badge {
    background: var(--badge-bg);
    color: var(--badge-fg);
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 0.85em;
  }

  .score { color: var(--accent); font-weight: 500; }

  .error {
    padding: 12px;
    color: var(--vscode-errorForeground);
    font-size: 0.85em;
    text-align: center;
  }
</style>
</head>
<body>
  <div class="search-box">
    <input
      class="search-input"
      type="text"
      placeholder="Search by intent..."
      id="search"
      autofocus
    />
    <div class="hint" id="hint">e.g. send an email, list issues, schedule meeting</div>
  </div>

  <div id="content">
    <div class="empty-state">
      <div class="icon">&#128270;</div>
      Search adapters &amp; flows by intent<br/>
      <span style="font-size:0.9em">Finds matching tools, flows, and adapters</span>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const searchInput = document.getElementById('search');
    const content = document.getElementById('content');
    const hint = document.getElementById('hint');
    let debounceTimer = null;

    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim();
      clearTimeout(debounceTimer);

      if (q.length === 0) {
        hint.textContent = 'e.g. send an email, list issues, schedule meeting';
        content.innerHTML = '<div class="empty-state"><div class="icon">&#128270;</div>Search adapters &amp; flows by intent<br/><span style="font-size:0.9em">Finds matching tools, flows, and adapters</span></div>';
        return;
      }

      if (q.length < 3) {
        hint.textContent = 'Type ' + (3 - q.length) + ' more character' + (3 - q.length > 1 ? 's' : '') + '...';
        return;
      }

      hint.textContent = '';
      debounceTimer = setTimeout(() => {
        vscode.postMessage({ type: 'search', query: q });
      }, 500);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = searchInput.value.trim();
        if (q.length >= 1) {
          clearTimeout(debounceTimer);
          hint.textContent = '';
          vscode.postMessage({ type: 'search', query: q });
        }
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.type === 'loading') {
        content.innerHTML = '<div class="loading"><span class="spinner"></span>Searching...</div>';
      }

      if (msg.type === 'results') {
        renderResults(msg.result);
      }
    });

    function renderResults(result) {
      if (!result) { return; }

      const hasFlowSearch = result.flowSearchResults && result.flowSearchResults.length > 0;
      const hasSkills = result.skills && result.skills.length > 0;
      const hasTools = result.tools && result.tools.length > 0;

      if (!hasFlowSearch && !hasSkills && !hasTools) {
        content.innerHTML = '<div class="empty-state">No results found.<br/>Try a different search term.</div>';
        return;
      }

      let html = '';

      // Flow Search section
      if (hasFlowSearch) {
        html += '<div class="section-header" data-action="focus-flows">';
        html += '&#9889; Flows (' + result.flowSearchResults.length + ')';
        html += '</div>';
        for (const f of result.flowSearchResults) {
          html += '<div class="result-item" data-action="focus-flows">';
          html += '  <div class="result-name">' + esc(f.name) + '</div>';
          html += '  <div class="result-meta">';
          html += '    <span class="score">' + f.matchPercent + '%</span>';
          html += '    <span class="badge">' + esc(f.flowType) + '</span>';
          if (f.adapter) { html += '    <span>' + esc(f.adapter) + '</span>'; }
          html += '  </div>';
          html += '</div>';
        }
      }

      // Skills section
      if (hasSkills) {
        html += '<div class="section-header" data-action="focus-flows">';
        html += '&#9889; Flows (' + result.skills.length + ')';
        html += '</div>';
        for (const s of result.skills) {
          html += '<div class="result-item" data-action="focus-flows">';
          html += '  <div class="result-name">' + esc(s.name) + '</div>';
          html += '  <div class="result-meta">';
          html += '    <span class="score">' + esc(s.matchPercent) + '</span>';
          if (s.description) { html += '    <span>' + esc(s.description.substring(0, 60)) + '</span>'; }
          html += '  </div>';
          html += '</div>';
        }
      }

      // Adapters/Tools section
      if (hasTools) {
        // Group by adapter
        const adapterMap = {};
        for (const t of result.tools) {
          if (!adapterMap[t.adapter_id]) { adapterMap[t.adapter_id] = []; }
          adapterMap[t.adapter_id].push(t);
        }
        const adapterIds = Object.keys(adapterMap);

        html += '<div class="section-header" data-action="focus-adapters">';
        html += '&#128268; Adapters (' + adapterIds.length + ')';
        html += '</div>';

        for (const adapterId of adapterIds) {
          const tools = adapterMap[adapterId].sort((a, b) => b.score - a.score);
          const bestScore = Math.round(Math.max(...tools.map(t => t.score)));

          html += '<div class="result-item" data-action="focus-adapters">';
          html += '  <div class="result-name">' + esc(adapterId) + '</div>';
          html += '  <div class="result-meta">';
          html += '    <span class="score">' + bestScore + '%</span>';
          html += '    <span>' + tools.length + ' tool' + (tools.length !== 1 ? 's' : '') + '</span>';
          html += '  </div>';
          html += '</div>';

          // Show top 3 tools
          for (const t of tools.slice(0, 3)) {
            const pct = Math.round(t.score);
            html += '<div class="result-item" style="padding-left:20px;" data-action="focus-adapters">';
            html += '  <div class="result-meta">';
            html += '    <span style="color:var(--fg);font-size:0.95em">' + esc(t.tool) + '</span>';
            html += '    <span class="score">' + pct + '%</span>';
            html += '  </div>';
            html += '</div>';
          }

          if (tools.length > 3) {
            html += '<div class="result-item" style="padding-left:20px;color:var(--fg-dim);font-size:0.85em">';
            html += '  +' + (tools.length - 3) + ' more tools';
            html += '</div>';
          }
        }
      }

      content.innerHTML = html;

      // Attach click handlers
      content.querySelectorAll('[data-action]').forEach(el => {
        el.addEventListener('click', () => {
          const action = el.dataset.action;
          if (action) { vscode.postMessage({ type: action }); }
        });
      });
    }

    function esc(s) {
      if (!s) return '';
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
  </script>
</body>
</html>`;
  }
}
