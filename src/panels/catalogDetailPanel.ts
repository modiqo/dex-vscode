import * as vscode from "vscode";
import { DexClient } from "../client/dexClient";
import { parseCatalogInfo } from "../commands/browseCatalog";
import { showAdapterWizardPanel } from "./adapterWizardPanel";

export async function showCatalogDetailPanel(
  extensionUri: vscode.Uri,
  client: DexClient,
  adapterId: string,
  onAdapterCreated?: () => void,
): Promise<void> {
  let info: Record<string, string>;
  try {
    const raw = await client.catalogInfo(adapterId);
    info = parseCatalogInfo(raw);
  } catch {
    vscode.window.showInformationMessage(
      `Install with: dex adapter new ${adapterId}`,
    );
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "modiqo.catalogDetail",
    `${info["Provider"] || adapterId}`,
    vscode.ViewColumn.One,
    { enableScripts: true },
  );

  panel.webview.html = buildDetailHtml(adapterId, info);

  panel.webview.onDidReceiveMessage((msg) => {
    if (msg.type === "install") {
      panel.dispose();
      showAdapterWizardPanel(
        extensionUri,
        client,
        adapterId,
        info,
        onAdapterCreated || (() => {}),
      );
    }
  });
}

function buildDetailHtml(
  adapterId: string,
  info: Record<string, string>,
): string {
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

  const badge =
    firstParty === "Yes"
      ? `<span class="badge first-party">first-party</span>`
      : `<span class="badge community">community</span>`;

  const tokenLink = tokenPage
    ? `<a href="${esc(tokenPage)}">${esc(tokenPage)}</a>`
    : "\u2014";

  const specLink = specUrl
    ? `<a href="${esc(specUrl)}">${truncUrl(specUrl)}</a>`
    : "\u2014";

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
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
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
    margin-bottom: 28px;
  }

  .header h1 {
    font-size: 1.6em;
    font-weight: 600;
    margin: 0 0 6px 0;
    letter-spacing: -0.01em;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .header .subtitle {
    color: var(--fg-dim);
    font-size: 0.95em;
  }

  .badge {
    display: inline-block;
    font-size: 0.5em;
    padding: 3px 10px;
    border-radius: 3px;
    font-weight: 500;
    letter-spacing: 0.03em;
    vertical-align: middle;
  }

  .badge.first-party {
    background: var(--badge-bg);
    color: var(--badge-fg);
  }

  .badge.community {
    border: 1px solid var(--border);
    color: var(--fg-dim);
  }

  .cards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin-bottom: 24px;
  }

  @media (max-width: 600px) {
    .cards { grid-template-columns: 1fr; }
  }

  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 18px 22px;
  }

  .card h2 {
    font-size: 0.78em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--fg-dim);
    margin: 0 0 12px 0;
  }

  .row {
    display: flex;
    padding: 5px 0;
    border-bottom: 1px solid var(--border);
  }

  .row:last-child {
    border-bottom: none;
  }

  .row .label {
    width: 110px;
    flex-shrink: 0;
    color: var(--fg-dim);
    font-size: 0.88em;
  }

  .row .value {
    flex: 1;
    font-size: 0.88em;
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
    margin-top: 24px;
    display: flex;
    gap: 14px;
    align-items: center;
  }

  .install-btn {
    padding: 9px 24px;
    background: var(--btn-bg);
    color: var(--btn-fg);
    border: none;
    border-radius: 4px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }

  .install-btn:hover {
    background: var(--btn-hover);
  }

  .install-cli {
    font-family: var(--vscode-editor-font-family);
    font-size: 0.83em;
    color: var(--fg-dim);
  }

  .notes {
    margin-top: 16px;
    color: var(--fg-dim);
    font-style: italic;
    font-size: 0.86em;
  }
</style>
</head>
<body>
  <div class="header">
    <h1>${esc(provider)} ${badge}</h1>
    <div class="subtitle">${esc(category)} \u2014 ${esc(adapterId)}</div>
  </div>

  <div class="cards">
    <div class="card">
      <h2>Specification</h2>
      <div class="row">
        <div class="label">Type</div>
        <div class="value">${esc(specType || "\u2014")}</div>
      </div>
      <div class="row">
        <div class="label">Spec Version</div>
        <div class="value">${esc(specVersion || "\u2014")}</div>
      </div>
      <div class="row">
        <div class="label">API Version</div>
        <div class="value">${esc(apiVersion || "\u2014")}</div>
      </div>
      <div class="row">
        <div class="label">Size</div>
        <div class="value">${esc(specSize || "\u2014")}</div>
      </div>
      <div class="row">
        <div class="label">Spec URL</div>
        <div class="value">${specLink}</div>
      </div>
    </div>

    <div class="card">
      <h2>Authentication</h2>
      <div class="row">
        <div class="label">Method</div>
        <div class="value">${esc(auth || "\u2014")}</div>
      </div>
      <div class="row">
        <div class="label">Token Page</div>
        <div class="value">${tokenLink}</div>
      </div>
    </div>
  </div>

  <div class="install-section">
    <button class="install-btn" onclick="vscode.postMessage({type:'install'})">Install Adapter</button>
    <span class="install-cli">or run: dex adapter new ${esc(adapterId)}</span>
  </div>

  ${notes ? `<div class="notes">${esc(notes)}</div>` : ""}

  <script>const vscode = acquireVsCodeApi();</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncUrl(url: string): string {
  if (url.length <= 60) {
    return esc(url);
  }
  return esc(url.substring(0, 57) + "...");
}
