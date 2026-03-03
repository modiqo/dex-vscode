import * as vscode from "vscode";
import { DexClient } from "../client/dexClient";
import { parseCatalogResults } from "../commands/browseCatalog";

export class CatalogViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "modiqo-catalog";

  private view?: vscode.WebviewView;
  private extensionUri: vscode.Uri;

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
      } else if (msg.type === "select") {
        vscode.commands.executeCommand("modiqo.catalogDetail", msg.adapterId);
      }
    });
  }

  refresh(): void {
    if (this.view) {
      this.view.webview.html = this.getHtml();
    }
  }

  private async handleSearch(query: string): Promise<void> {
    if (!this.view) { return; }

    this.view.webview.postMessage({ type: "loading" });

    try {
      const raw = await this.client.catalogSearch(query.trim());
      const results = parseCatalogResults(raw);
      this.view.webview.postMessage({ type: "results", results });
    } catch {
      this.view.webview.postMessage({
        type: "error",
        message: "Search failed. Check that dex is running.",
      });
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
    --active: var(--vscode-list-activeSelectionBackground);
    --active-fg: var(--vscode-list-activeSelectionForeground);
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

  .search-input::placeholder {
    color: var(--input-placeholder);
  }

  .search-input:focus {
    border-color: var(--vscode-focusBorder);
  }

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

  .empty-state .icon {
    font-size: 2em;
    margin-bottom: 8px;
    opacity: 0.5;
  }

  .loading {
    text-align: center;
    padding: 20px;
    color: var(--fg-dim);
    font-size: 0.85em;
  }

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid var(--fg-dim);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    vertical-align: middle;
    margin-right: 6px;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .results-header {
    padding: 6px 2px;
    font-size: 0.8em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fg-dim);
  }

  .result-item {
    display: flex;
    flex-direction: column;
    padding: 6px 8px;
    border-radius: 4px;
    cursor: pointer;
    border-bottom: 1px solid var(--border);
  }

  .result-item:last-child {
    border-bottom: none;
  }

  .result-item:hover {
    background: var(--hover);
  }

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
    margin-top: 2px;
  }

  .result-category {
    background: var(--badge-bg);
    color: var(--badge-fg);
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 0.85em;
  }

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
      placeholder="Search 635+ APIs..."
      id="search"
      autofocus
    />
    <div class="hint" id="hint">Type 3+ characters to search</div>
  </div>

  <div id="content">
    <div class="empty-state">
      <div class="icon">&#128269;</div>
      Search by name, category, or provider<br/>
      <span style="font-size:0.9em">e.g. stripe, email, calendar, crm</span>
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
        hint.textContent = 'Type 3+ characters to search';
        content.innerHTML = '<div class="empty-state"><div class="icon">&#128269;</div>Search by name, category, or provider<br/><span style="font-size:0.9em">e.g. stripe, email, calendar, crm</span></div>';
        return;
      }

      if (q.length < 3) {
        hint.textContent = 'Type ' + (3 - q.length) + ' more character' + (3 - q.length > 1 ? 's' : '') + '...';
        return;
      }

      hint.textContent = '';
      debounceTimer = setTimeout(() => {
        vscode.postMessage({ type: 'search', query: q });
      }, 400);
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
        const results = msg.results;
        if (results.length === 0) {
          content.innerHTML = '<div class="empty-state">No APIs found.<br/>Try a different search term.</div>';
          return;
        }

        let html = '<div class="results-header">' + results.length + ' result' + (results.length !== 1 ? 's' : '') + '</div>';
        for (const r of results) {
          html += '<div class="result-item" data-id="' + escapeAttr(r.id) + '">';
          html += '  <div class="result-name">' + escapeHtml(r.id) + '</div>';
          html += '  <div class="result-meta">';
          if (r.category) {
            html += '<span class="result-category">' + escapeHtml(r.category) + '</span>';
          }
          if (r.provider) {
            html += '<span>' + escapeHtml(r.provider) + '</span>';
          }
          html += '  </div>';
          html += '</div>';
        }
        content.innerHTML = html;

        content.querySelectorAll('.result-item').forEach(el => {
          el.addEventListener('click', () => {
            vscode.postMessage({ type: 'select', adapterId: el.dataset.id });
          });
        });
      }

      if (msg.type === 'error') {
        content.innerHTML = '<div class="error">' + escapeHtml(msg.message) + '</div>';
      }
    });

    function escapeHtml(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function escapeAttr(s) {
      return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
  </script>
</body>
</html>`;
  }
}
