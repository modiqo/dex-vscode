import * as vscode from "vscode";
import { DexClient } from "../client/dexClient";

export function registerBrowseCatalog(
  client: DexClient,
  extensionUri: vscode.Uri
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "modiqo.browseCatalog",
    async () => {
      const query = await vscode.window.showInputBox({
        prompt: "Search the adapter catalog (635 APIs)",
        placeHolder: "e.g. stripe, email, calendar, crm, ai ...",
      });

      if (query === undefined || query.trim().length === 0) {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Searching catalog for "${query}"...`,
          cancellable: false,
        },
        async () => {
          try {
            const raw = await client.catalogSearch(query.trim());
            const results = parseCatalogResults(raw);

            if (results.length === 0) {
              vscode.window.showInformationMessage(
                `No adapters found for "${query}".`
              );
              return;
            }

            const picked = await vscode.window.showQuickPick(
              results.map((r) => ({
                label: r.id,
                description: r.category,
                detail: r.provider,
              })),
              {
                placeHolder: `${results.length} result(s) — select to view details`,
              }
            );

            if (!picked) {
              return;
            }

            try {
              const info = await client.catalogInfo(picked.label);
              const parsed = parseCatalogInfo(info);
              showCatalogDetailPanel(extensionUri, picked.label, parsed);
            } catch {
              vscode.window.showInformationMessage(
                `Install with: dex adapter new ${picked.label}`
              );
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Catalog search failed: ${msg}`);
          }
        }
      );
    }
  );
}

// ── Types ─────────────────────────────────────────────────────────

interface CatalogResult {
  id: string;
  category: string;
  provider: string;
}

interface CatalogInfo {
  [key: string]: string;
}

// ── Parsers ───────────────────────────────────────────────────────

function parseCatalogResults(text: string): CatalogResult[] {
  const results: CatalogResult[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith("Catalog") ||
      trimmed.startsWith("ID") ||
      trimmed.startsWith("\u2500") ||
      trimmed.startsWith("Use:") ||
      trimmed.startsWith("Create:")
    ) {
      continue;
    }
    const parts = trimmed.split(/\s{2,}/);
    if (parts.length >= 3) {
      results.push({ id: parts[0], category: parts[1], provider: parts[2] });
    } else if (parts.length === 2) {
      results.push({ id: parts[0], category: parts[1], provider: "" });
    }
  }
  return results;
}

function parseCatalogInfo(text: string): CatalogInfo {
  const info: CatalogInfo = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    // Skip empty, "Catalog: X" header, and "Create adapter:" footer lines
    if (!trimmed || trimmed.startsWith("Catalog:")) {
      continue;
    }
    if (trimmed.startsWith("Create adapter:") || trimmed.startsWith("With defaults:")) {
      continue;
    }
    // Format: "  Key:     Value"
    const match = trimmed.match(/^([^:]+):\s+(.+)$/);
    if (match) {
      info[match[1].trim()] = match[2].trim();
    }
  }
  return info;
}

// ── Webview Panel ─────────────────────────────────────────────────

function showCatalogDetailPanel(
  extensionUri: vscode.Uri,
  adapterId: string,
  info: CatalogInfo
): void {
  const panel = vscode.window.createWebviewPanel(
    "modiqo.catalogDetail",
    `${info["Provider"] || adapterId}`,
    vscode.ViewColumn.One,
    { enableScripts: true }
  );

  panel.webview.html = buildDetailHtml(adapterId, info);
}

function buildDetailHtml(adapterId: string, info: CatalogInfo): string {
  const provider = info["Provider"] || adapterId;
  const category = info["Category"] || "";
  const specType = info["Spec Type"] || "";
  const specVersion = info["Spec Version"] || "";
  const apiVersion = info["API Version"] || "";
  const specSize = info["Spec Size"] || "";
  const auth = info["Auth"] || "";
  const tokenPage = info["Token Page"] || "";
  const specUrl = info["Spec URL"] || "";
  const notes = info["Notes"] || "";
  const firstParty = info["First-party"] || "";

  const badge = firstParty === "Yes"
    ? `<span class="badge first-party">first-party</span>`
    : `<span class="badge community">community</span>`;

  const tokenLink = tokenPage
    ? `<a href="${escapeHtml(tokenPage)}">${escapeHtml(tokenPage)}</a>`
    : "—";

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
  }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--fg);
    background: var(--bg);
    margin: 0;
    padding: 32px 40px;
    line-height: 1.6;
  }

  .header {
    margin-bottom: 32px;
  }

  .header h1 {
    font-size: 1.6em;
    font-weight: 600;
    margin: 0 0 6px 0;
    letter-spacing: -0.01em;
  }

  .header .subtitle {
    color: var(--fg-dim);
    font-size: 0.95em;
  }

  .badge {
    display: inline-block;
    font-size: 0.75em;
    padding: 2px 8px;
    border-radius: 3px;
    margin-left: 10px;
    vertical-align: middle;
    font-weight: 500;
    letter-spacing: 0.03em;
  }

  .badge.first-party {
    background: var(--badge-bg);
    color: var(--badge-fg);
  }

  .badge.community {
    border: 1px solid var(--border);
    color: var(--fg-dim);
  }

  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 20px 24px;
    margin-bottom: 20px;
  }

  .card h2 {
    font-size: 0.8em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--fg-dim);
    margin: 0 0 14px 0;
  }

  .row {
    display: flex;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
  }

  .row:last-child {
    border-bottom: none;
  }

  .row .label {
    width: 140px;
    flex-shrink: 0;
    color: var(--fg-dim);
    font-size: 0.9em;
  }

  .row .value {
    flex: 1;
    font-size: 0.9em;
    word-break: break-all;
  }

  .row .value a {
    color: var(--accent);
    text-decoration: none;
  }

  .row .value a:hover {
    text-decoration: underline;
  }

  .install-section {
    margin-top: 28px;
    padding: 16px 20px;
    border: 1px dashed var(--border);
    border-radius: 6px;
    font-family: var(--vscode-editor-font-family);
    font-size: 0.9em;
  }

  .install-section .cmd {
    color: var(--accent);
    font-weight: 500;
  }

  .notes {
    margin-top: 12px;
    color: var(--fg-dim);
    font-style: italic;
    font-size: 0.88em;
  }
</style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(provider)} ${badge}</h1>
    <div class="subtitle">${escapeHtml(category)} — ${escapeHtml(adapterId)}</div>
  </div>

  <div class="card">
    <h2>Specification</h2>
    <div class="row">
      <div class="label">Type</div>
      <div class="value">${escapeHtml(specType)}</div>
    </div>
    <div class="row">
      <div class="label">Spec Version</div>
      <div class="value">${escapeHtml(specVersion)}</div>
    </div>
    <div class="row">
      <div class="label">API Version</div>
      <div class="value">${escapeHtml(apiVersion || "—")}</div>
    </div>
    <div class="row">
      <div class="label">Size</div>
      <div class="value">${escapeHtml(specSize)}</div>
    </div>
    <div class="row">
      <div class="label">Spec URL</div>
      <div class="value"><a href="${escapeHtml(specUrl)}">${truncateUrl(specUrl)}</a></div>
    </div>
  </div>

  <div class="card">
    <h2>Authentication</h2>
    <div class="row">
      <div class="label">Method</div>
      <div class="value">${escapeHtml(auth)}</div>
    </div>
    <div class="row">
      <div class="label">Token Page</div>
      <div class="value">${tokenLink}</div>
    </div>
  </div>

  <div class="install-section">
    <span class="cmd">dex adapter new ${escapeHtml(adapterId)}</span>
  </div>

  ${notes ? `<div class="notes">${escapeHtml(notes)}</div>` : ""}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncateUrl(url: string): string {
  if (url.length <= 60) { return escapeHtml(url); }
  return escapeHtml(url.substring(0, 57) + "...");
}
