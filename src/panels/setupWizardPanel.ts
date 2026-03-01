import * as vscode from "vscode";
import type {
  DexClient,
  ProofResult,
} from "../client/dexClient";

interface SetupCallbacks {
  onComplete: () => void;
  onAdaptersInstalled?: () => void;
  onTokensConfigured?: () => void;
}

let currentPanel: vscode.WebviewPanel | undefined;

export function showSetupWizardPanel(
  extensionUri: vscode.Uri,
  client: DexClient,
  callbacks: SetupCallbacks,
): void {
  if (currentPanel) {
    currentPanel.reveal();
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "modiqo.setupWizard",
    "dex Setup",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  currentPanel = panel;
  panel.onDidDispose(() => { currentPanel = undefined; });

  panel.webview.html = buildHtml();

  // Load available adapters for step 3
  loadRegistryData(panel, client);

  panel.webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
      case "login": {
        handleLogin(panel, client, msg.provider);
        break;
      }
      case "install-adapters": {
        await handleInstallAdapters(panel, client, msg.adapters);
        // Start daemon after adapters are installed (needed for proof-of-life)
        await client.startDaemon();
        callbacks.onAdaptersInstalled?.();
        break;
      }
      case "configure-token": {
        const ok = await client.tokenSet(msg.env_var, msg.value);
        panel.webview.postMessage({
          type: "token-status",
          env_var: msg.env_var,
          configured: ok,
        });
        if (ok) { callbacks.onTokensConfigured?.(); }
        break;
      }
      case "oauth-setup-google": {
        handleOAuthGoogle(panel, client, msg.scopes);
        break;
      }
      case "wire-clients": {
        await handleWireClients(panel, client, msg.clients);
        break;
      }
      case "run-proof-of-life": {
        await handleProofOfLife(panel, client, msg.adapters);
        break;
      }
      case "load-token-requirements": {
        const reqs = await client.detectTokenRequirements();
        const vaultTokens = await client.vaultTokenList();
        panel.webview.postMessage({
          type: "token-requirements",
          requirements: reqs,
          vaultTokens,
        });
        break;
      }
      case "vault-pull": {
        const passphrase = await vscode.window.showInputBox({
          prompt: "Enter vault passphrase",
          placeHolder: "Passphrase for encrypted vault",
          password: true,
        });
        if (!passphrase) {
          panel.webview.postMessage({ type: "vault-pull-status", success: false, message: "Cancelled" });
          break;
        }
        const pullOk = await client.vaultPull(passphrase);
        panel.webview.postMessage({
          type: "vault-pull-status",
          success: pullOk,
          message: pullOk ? "Vault pulled — tokens restored" : "Vault pull failed. Check passphrase.",
        });
        if (pullOk) {
          callbacks.onTokensConfigured?.();
          // Reload token requirements with refreshed vault data
          const freshReqs = await client.detectTokenRequirements();
          const freshVault = await client.vaultTokenList();
          panel.webview.postMessage({
            type: "token-requirements",
            requirements: freshReqs,
            vaultTokens: freshVault,
          });
        }
        break;
      }
      case "complete-setup": {
        // Ensure stdio baseline + daemon before completing
        await client.ensureStdioBaseline();
        await client.startDaemon();
        callbacks.onComplete();
        panel.dispose();
        break;
      }
    }
  });
}

async function loadRegistryData(
  panel: vscode.WebviewPanel,
  client: DexClient,
): Promise<void> {
  try {
    const [adapters, skills] = await Promise.all([
      client.registryAdapterList("bootstrap"),
      client.registrySkillList("bootstrap"),
    ]);
    panel.webview.postMessage({
      type: "adapters-available",
      adapters,
      skills,
    });
  } catch {
    // Silently fail — user may not be logged in yet
  }
}

function handleLogin(
  panel: vscode.WebviewPanel,
  client: DexClient,
  provider: string,
): void {
  const child = client.execStream(["login", "--provider", provider]);

  panel.webview.postMessage({ type: "login-status", status: "polling" });

  // Poll whoami every 2s
  let attempts = 0;
  const maxAttempts = 60;
  const interval = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(interval);
      child.kill();
      panel.webview.postMessage({
        type: "login-status",
        status: "timeout",
      });
      return;
    }

    try {
      const whoami = await client.registryWhoami();
      if (whoami.status === "valid") {
        clearInterval(interval);
        child.kill();
        // Reload adapters now that we're logged in
        loadRegistryData(panel, client);
        panel.webview.postMessage({
          type: "login-status",
          status: "success",
          email: whoami.email,
        });
      }
    } catch {
      // Keep polling
    }
  }, 2000);

  panel.onDidDispose(() => {
    clearInterval(interval);
    child.kill();
  });
}

async function handleInstallAdapters(
  panel: vscode.WebviewPanel,
  client: DexClient,
  adapterIds: string[],
): Promise<void> {
  for (const id of adapterIds) {
    panel.webview.postMessage({
      type: "install-progress",
      adapter: id,
      status: "installing",
      message: "Connecting to registry...",
      logs: [],
    });

    const child = client.installAdapterStream(id);
    const logLines: string[] = [];

    const pushLog = (raw: string) => {
      const lines = raw.split("\n").map((l: string) => l.trim()).filter(Boolean);
      for (const line of lines) {
        // Skip empty decorator lines
        if (/^[─┌┐└┘├┤┬┴┼│]+$/.test(line)) { continue; }
        logLines.push(line);
      }
      // Keep last 3 lines
      const recent = logLines.slice(-3);
      panel.webview.postMessage({
        type: "install-progress",
        adapter: id,
        status: "installing",
        message: recent[recent.length - 1] || "Installing...",
        logs: recent,
      });
    };

    child.stdout?.on("data", (data: Buffer) => {
      pushLog(data.toString());
    });
    child.stderr?.on("data", (data: Buffer) => {
      pushLog(data.toString());
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", resolve);
      child.on("error", () => resolve(1));
    });

    if (exitCode === 0) {
      // Pull associated flows/skills for this adapter
      const recent = logLines.slice(-3);
      panel.webview.postMessage({
        type: "install-progress",
        adapter: id,
        status: "installing",
        message: "Pulling associated flows...",
        logs: recent,
      });

      const skillCount = await client.pullAssociatedSkills(id);
      const msg = skillCount > 0
        ? `Installed (${skillCount} flow${skillCount !== 1 ? "s" : ""})`
        : "Installed";

      panel.webview.postMessage({
        type: "install-progress",
        adapter: id,
        status: "success",
        message: msg,
        logs: recent,
      });
    } else {
      const recent = logLines.slice(-3);
      panel.webview.postMessage({
        type: "install-progress",
        adapter: id,
        status: "error",
        message: recent[recent.length - 1] || "Installation failed",
        logs: recent,
      });
    }
  }
}

function handleOAuthGoogle(
  panel: vscode.WebviewPanel,
  client: DexClient,
  scopes: string[],
): void {
  panel.webview.postMessage({
    type: "oauth-status",
    status: "starting",
    message: "Opening browser for Google consent...",
  });

  const child = client.oauthSetupGoogle(scopes);
  let output = "";

  child.stdout?.on("data", (data: Buffer) => {
    output += data.toString();
    panel.webview.postMessage({
      type: "oauth-status",
      status: "in-progress",
      message: output.split("\n").filter(Boolean).pop() || "Waiting...",
    });
  });

  child.stderr?.on("data", (data: Buffer) => {
    output += data.toString();
  });

  child.on("close", (code) => {
    panel.webview.postMessage({
      type: "oauth-status",
      status: code === 0 ? "success" : "error",
      message: code === 0
        ? "Google OAuth configured"
        : "OAuth setup failed — check browser",
    });
  });

  panel.onDidDispose(() => { child.kill(); });
}

async function handleWireClients(
  panel: vscode.WebviewPanel,
  client: DexClient,
  clientIds: string[],
): Promise<void> {
  for (const id of clientIds) {
    panel.webview.postMessage({
      type: "wire-progress",
      client: id,
      status: "wiring",
    });

    const ok = await client.wireClient(id);
    panel.webview.postMessage({
      type: "wire-progress",
      client: id,
      status: ok ? "success" : "error",
    });
  }
}

async function handleProofOfLife(
  panel: vscode.WebviewPanel,
  client: DexClient,
  adapterIds: string[],
): Promise<void> {
  const results: ProofResult[] = [];

  for (const id of adapterIds) {
    panel.webview.postMessage({
      type: "proof-result",
      adapter: id,
      status: "running",
    });

    const result = await client.runProofOfLife(id);
    results.push(result);

    panel.webview.postMessage({
      type: "proof-result",
      adapter: id,
      status: result.success ? "success" : "error",
      output: result.output,
      error: result.error,
    });
  }
}

// ── HTML builder ──────────────────────────────────────────────

function buildHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
${CSS}
</style>
</head>
<body>
  <div class="wizard">
    <div class="progress-bar" id="progressBar"></div>
    <div class="step-container" id="stepContainer"></div>
  </div>
  <script>
${JS}
  </script>
</body>
</html>`;
}

// ── CSS ───────────────────────────────────────────────────────

const CSS = `
:root {
  --fg: var(--vscode-foreground);
  --bg: var(--vscode-editor-background);
  --bg-alt: var(--vscode-sideBar-background, #1e1e1e);
  --border: var(--vscode-panel-border, #333);
  --accent: var(--vscode-textLink-foreground, #4fc1ff);
  --accent-hover: var(--vscode-textLink-activeForeground, #6fd3ff);
  --btn-bg: var(--vscode-button-background, #0e639c);
  --btn-fg: var(--vscode-button-foreground, #fff);
  --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
  --btn-secondary-bg: var(--vscode-button-secondaryBackground, #3a3d41);
  --btn-secondary-fg: var(--vscode-button-secondaryForeground, #ccc);
  --input-bg: var(--vscode-input-background, #3c3c3c);
  --input-border: var(--vscode-input-border, #555);
  --input-fg: var(--vscode-input-foreground, #ccc);
  --success: #4ec9b0;
  --error: #f14c4c;
  --warning: #cca700;
  --card-bg: var(--vscode-editorWidget-background, #252526);
  --card-border: var(--vscode-editorWidget-border, #454545);
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
  font-size: 13px;
  color: var(--fg);
  background: var(--bg);
  line-height: 1.5;
}

.wizard {
  max-width: 720px;
  margin: 0 auto;
  padding: 32px 24px;
}

/* ── Progress bar ────────────────────────── */

.progress-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  margin-bottom: 40px;
  padding: 0 20px;
}

.progress-step {
  display: flex;
  align-items: center;
  gap: 0;
}

.progress-dot {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--border);
  transition: all 0.3s ease;
  flex-shrink: 0;
}

.progress-dot.active {
  border-color: var(--accent);
  color: var(--accent);
  box-shadow: 0 0 0 3px rgba(79, 193, 255, 0.15);
}

.progress-dot.done {
  border-color: var(--success);
  background: var(--success);
  color: #000;
}

.progress-line {
  width: 40px;
  height: 2px;
  background: var(--border);
  transition: background 0.3s ease;
}

.progress-line.done {
  background: var(--success);
}

/* ── Step container ──────────────────────── */

.step-container {
  animation: fadeIn 0.3s ease;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ── Typography ──────────────────────────── */

h1 {
  font-size: 28px;
  font-weight: 300;
  letter-spacing: -0.5px;
  margin-bottom: 8px;
}

h2 {
  font-size: 18px;
  font-weight: 500;
  margin-bottom: 6px;
}

.subtitle {
  color: var(--vscode-descriptionForeground, #888);
  font-size: 14px;
  margin-bottom: 32px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--vscode-descriptionForeground, #888);
  margin-bottom: 16px;
}

/* ── Buttons ─────────────────────────────── */

.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 24px;
  border: none;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  font-family: inherit;
}

.btn-primary {
  background: var(--btn-bg);
  color: var(--btn-fg);
}

.btn-primary:hover { background: var(--btn-hover); }

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  background: var(--btn-secondary-bg);
  color: var(--btn-secondary-fg);
}

.btn-secondary:hover { opacity: 0.9; }

.btn-ghost {
  background: transparent;
  color: var(--accent);
  padding: 10px 16px;
}

.btn-ghost:hover { text-decoration: underline; }

.btn-link {
  color: var(--accent);
  font-size: 12px;
  text-decoration: none;
  cursor: pointer;
  opacity: 0.85;
}

.btn-link:hover {
  text-decoration: underline;
  opacity: 1;
}

.btn-row {
  display: flex;
  gap: 12px;
  margin-top: 24px;
}

.btn-row-right {
  display: flex;
  gap: 12px;
  margin-top: 24px;
  justify-content: flex-end;
}

/* ── Cards ───────────────────────────────── */

.card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 8px;
  padding: 20px;
  transition: border-color 0.15s ease;
}

.card:hover {
  border-color: var(--accent);
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.card-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 16px;
}

/* ── Provider cards (login) ──────────────── */

.provider-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin: 24px 0;
}

.provider-card {
  background: var(--card-bg);
  border: 2px solid var(--card-border);
  border-radius: 12px;
  padding: 32px 24px;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s ease;
}

.provider-card:hover {
  border-color: var(--accent);
  transform: translateY(-2px);
}

.provider-card .icon {
  font-size: 36px;
  margin-bottom: 12px;
}

.provider-card .name {
  font-size: 16px;
  font-weight: 500;
  margin-bottom: 4px;
}

.provider-card .hint {
  font-size: 12px;
  color: var(--vscode-descriptionForeground, #888);
}

/* ── Adapter selection cards ─────────────── */

.adapter-card {
  background: var(--card-bg);
  border: 2px solid var(--card-border);
  border-radius: 8px;
  padding: 14px 16px;
  cursor: pointer;
  transition: all 0.15s ease;
  position: relative;
}

.adapter-card:hover { border-color: var(--accent); }

.adapter-card.selected {
  border-color: var(--accent);
  background: rgba(79, 193, 255, 0.06);
}

.adapter-card .check {
  position: absolute;
  top: 8px;
  right: 10px;
  width: 18px;
  height: 18px;
  border: 2px solid var(--border);
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  transition: all 0.15s ease;
}

.adapter-card.selected .check {
  border-color: var(--accent);
  background: var(--accent);
  color: #000;
}

.adapter-card .adapter-name {
  font-weight: 500;
  margin-bottom: 2px;
  padding-right: 28px;
}

.adapter-card .adapter-desc {
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #888);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* ── Token configuration ─────────────────── */

.token-card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 8px;
  padding: 16px;
}

.token-card.configured {
  border-color: var(--success);
}

.token-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.token-name {
  font-weight: 600;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 13px;
}

.token-adapters {
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #888);
  margin-bottom: 10px;
}

.token-input-row {
  display: flex;
  gap: 8px;
}

.token-input {
  flex: 1;
  padding: 7px 10px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 4px;
  color: var(--input-fg);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
}

.token-input:focus {
  outline: none;
  border-color: var(--accent);
}

/* ── Wire client cards ───────────────────── */

.wire-card {
  background: var(--card-bg);
  border: 2px solid var(--card-border);
  border-radius: 8px;
  padding: 20px;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  gap: 16px;
}

.wire-card:hover { border-color: var(--accent); }

.wire-card.selected {
  border-color: var(--accent);
  background: rgba(79, 193, 255, 0.06);
}

.wire-icon {
  font-size: 28px;
  flex-shrink: 0;
}

.wire-info { flex: 1; }

.wire-name { font-weight: 500; font-size: 14px; }

.wire-desc {
  font-size: 12px;
  color: var(--vscode-descriptionForeground, #888);
}

.wire-check {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border);
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  flex-shrink: 0;
}

.wire-card.selected .wire-check {
  border-color: var(--accent);
  background: var(--accent);
  color: #000;
}

/* ── Proof of life ───────────────────────── */

.proof-card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.proof-card.success { border-color: var(--success); }
.proof-card.error { border-color: var(--error); }

.proof-icon {
  font-size: 20px;
  flex-shrink: 0;
  width: 28px;
  text-align: center;
  padding-top: 2px;
}

.proof-info { flex: 1; }

.proof-name {
  font-weight: 600;
  margin-bottom: 6px;
}

.proof-summary {
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.7;
  font-family: var(--vscode-editor-font-family, monospace);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 120px;
  overflow-y: auto;
}

.proof-summary .proof-line {
  display: block;
  padding: 1px 0;
}

.proof-summary .proof-line:first-child {
  opacity: 1;
  font-weight: 500;
}

.proof-error-hint {
  font-size: 11px;
  opacity: 0.6;
  margin-top: 4px;
}

.proof-name { font-weight: 500; }

.proof-output {
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #888);
  font-family: var(--vscode-editor-font-family, monospace);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 480px;
}

/* ── Status indicators ───────────────────── */

.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 500;
}

.status-badge.success {
  background: rgba(78, 201, 176, 0.15);
  color: var(--success);
}

.status-badge.error {
  background: rgba(241, 76, 76, 0.15);
  color: var(--error);
}

.status-badge.pending {
  background: rgba(204, 167, 0, 0.15);
  color: var(--warning);
}

/* ── Spinner ─────────────────────────────── */

@keyframes spin {
  to { transform: rotate(360deg); }
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  display: inline-block;
}

.spinner-lg {
  width: 24px;
  height: 24px;
}

/* ── Welcome hero ────────────────────────── */

.hero {
  text-align: center;
  padding: 48px 0 32px;
}

.hero-logo {
  font-size: 56px;
  margin-bottom: 16px;
}

.hero h1 {
  font-size: 32px;
  font-weight: 300;
  letter-spacing: -0.5px;
}

.hero .tagline {
  font-size: 16px;
  color: var(--vscode-descriptionForeground, #888);
  margin: 8px 0 36px;
}

/* ── Complete screen ─────────────────────── */

.complete-hero {
  text-align: center;
  padding: 40px 0;
}

.complete-hero h1 {
  color: var(--success);
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin: 32px 0;
}

.summary-card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 8px;
  padding: 20px;
  text-align: center;
}

.summary-number {
  font-size: 28px;
  font-weight: 300;
  color: var(--accent);
  margin-bottom: 4px;
}

.summary-label {
  font-size: 12px;
  color: var(--vscode-descriptionForeground, #888);
}

/* ── OAuth scope toggle chips ────────────── */

.scope-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px;
  margin: 12px 0 16px 0;
}

.scope-chip {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 8px;
  border: 1.5px solid var(--card-border);
  background: var(--card-bg);
  cursor: pointer;
  transition: all 0.15s ease;
  user-select: none;
}

.scope-chip:hover {
  border-color: var(--accent);
}

.scope-chip.selected {
  border-color: var(--accent);
  background: rgba(79, 193, 255, 0.08);
}

.scope-chip input[type="checkbox"] {
  display: none;
}

.scope-check {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  border: 2px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 11px;
  color: transparent;
  transition: all 0.15s ease;
}

.scope-chip.selected .scope-check {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.scope-label {
  font-size: 13px;
  font-weight: 500;
}

.scope-desc {
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #888);
  line-height: 1.3;
}

/* ── Login status ────────────────────────── */

.login-status {
  text-align: center;
  padding: 32px;
}

.login-status .email {
  font-weight: 500;
  color: var(--success);
  font-size: 15px;
  margin-top: 8px;
}

/* ── Misc ────────────────────────────────── */

/* ── Log buffer ──────────────────────────── */

.log-buffer {
  margin-top: 8px;
  padding: 6px 10px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 4px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
  line-height: 1.5;
  color: var(--vscode-descriptionForeground, #888);
  max-height: 54px;
  overflow: hidden;
}

.log-buffer .log-line {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.spacer { height: 16px; }
.spacer-lg { height: 32px; }

.muted {
  color: var(--vscode-descriptionForeground, #888);
  font-size: 12px;
}

.text-success { color: var(--success); }
.text-error { color: var(--error); }
`;

// ── JavaScript ────────────────────────────────────────────────

const JS = `
const vscode = acquireVsCodeApi();

// ── State ──────────────────────────────────

let currentStep = 0;
const STEPS = ['Welcome', 'Login', 'Adapters', 'Auth', 'Wire', 'Verify', 'Complete'];

// Data collected through steps
let loginEmail = '';
let registryAdapters = [];
let registrySkills = [];
let selectedAdapters = new Set();
let installedAdapters = [];
let tokenRequirements = [];
let selectedWireClients = new Set();
let proofResults = {};

// Popular adapters to pre-select
const POPULAR = ['github', 'stripe', 'gmail', 'slack', 'jira', 'notion', 'linear'];

// Wire client definitions
const WIRE_CLIENTS = [
  { id: 'dex-skill-claude-code', name: 'Claude Code', icon: '\\u{1F916}', desc: 'Wire dex tools into Claude Code' },
  { id: 'dex-skill-cursor', name: 'Cursor', icon: '\\u{1F4BB}', desc: 'Wire dex tools into Cursor IDE' },
  { id: 'dex-skill-codex', name: 'Codex', icon: '\\u{26A1}', desc: 'Wire dex tools into OpenAI Codex' },
  { id: 'dex-agents-md', name: 'AGENTS.md', icon: '\\u{1F4C4}', desc: 'Generate an AGENTS.md reference file' },
];

// ── Message handling ───────────────────────

window.addEventListener('message', (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'adapters-available':
      registryAdapters = msg.adapters || [];
      registrySkills = msg.skills || [];
      if (currentStep === 2) renderStep();
      break;

    case 'login-status':
      handleLoginStatus(msg);
      break;

    case 'install-progress':
      handleInstallProgress(msg);
      break;

    case 'token-requirements':
      tokenRequirements = msg.requirements || [];
      renderTokenStep(msg.vaultTokens || []);
      break;

    case 'token-status':
      handleTokenStatus(msg);
      break;

    case 'oauth-status':
      handleOAuthStatus(msg);
      break;

    case 'wire-progress':
      handleWireProgress(msg);
      break;

    case 'proof-result':
      handleProofResult(msg);
      break;

    case 'vault-pull-status':
      handleVaultPullStatus(msg);
      break;
  }
});

// ── Rendering ──────────────────────────────

function renderProgressBar() {
  const bar = document.getElementById('progressBar');
  let html = '';
  for (let i = 0; i < STEPS.length; i++) {
    const cls = i < currentStep ? 'done' : i === currentStep ? 'active' : '';
    const icon = i < currentStep ? '\\u2713' : (i + 1);
    html += '<div class="progress-step">';
    html += '<div class="progress-dot ' + cls + '">' + icon + '</div>';
    if (i < STEPS.length - 1) {
      html += '<div class="progress-line ' + (i < currentStep ? 'done' : '') + '"></div>';
    }
    html += '</div>';
  }
  bar.innerHTML = html;
}

function renderStep() {
  renderProgressBar();
  const container = document.getElementById('stepContainer');
  container.style.animation = 'none';
  container.offsetHeight; // Trigger reflow
  container.style.animation = 'fadeIn 0.3s ease';

  switch (currentStep) {
    case 0: renderWelcome(container); break;
    case 1: renderLogin(container); break;
    case 2: renderAdapters(container); break;
    case 3: renderAuth(container); break;
    case 4: renderWire(container); break;
    case 5: renderProof(container); break;
    case 6: renderComplete(container); break;
  }
}

function goTo(step) {
  currentStep = step;
  renderStep();
}

function next() { goTo(currentStep + 1); }

// ── Step 0: Welcome ────────────────────────

function renderWelcome(el) {
  el.innerHTML = \`
    <div class="hero">
      <div class="hero-logo">\\u{2B21}</div>
      <h1>Welcome to dex</h1>
      <div class="tagline">Any API. Agent-ready. One command.</div>
      <button class="btn btn-primary" onclick="next()">
        Let's get started \\u2192
      </button>
    </div>
  \`;
}

// ── Step 1: Login ──────────────────────────

function renderLogin(el) {
  if (loginEmail) {
    el.innerHTML = \`
      <h2>Signed in</h2>
      <div class="subtitle">You're authenticated with the dex registry.</div>
      <div class="login-status">
        <div style="font-size: 48px; margin-bottom: 12px;">\\u2713</div>
        <div class="email">\${loginEmail}</div>
      </div>
      <div class="btn-row-right">
        <button class="btn btn-primary" onclick="next()">Continue \\u2192</button>
      </div>
    \`;
    return;
  }

  el.innerHTML = \`
    <h2>Sign in to dex Registry</h2>
    <div class="subtitle">Connect your account to access adapters and skills.</div>
    <div class="provider-cards">
      <div class="provider-card" onclick="doLogin('google')">
        <div class="icon">G</div>
        <div class="name">Google</div>
        <div class="hint">Sign in with Google</div>
      </div>
      <div class="provider-card" onclick="doLogin('github')">
        <div class="icon">\\u{1F419}</div>
        <div class="name">GitHub</div>
        <div class="hint">Sign in with GitHub</div>
      </div>
    </div>
    <div id="loginStatus"></div>
    <div class="btn-row-right">
      <button class="btn btn-ghost" onclick="next()">Skip for now</button>
    </div>
  \`;
}

function doLogin(provider) {
  vscode.postMessage({ type: 'login', provider });
}

function handleLoginStatus(msg) {
  const el = document.getElementById('loginStatus');
  if (!el) return;

  if (msg.status === 'polling') {
    el.innerHTML = \`
      <div class="login-status">
        <div class="spinner spinner-lg"></div>
        <p style="margin-top: 12px;">Waiting for browser authentication...</p>
      </div>
    \`;
  } else if (msg.status === 'success') {
    loginEmail = msg.email;
    renderStep();
  } else if (msg.status === 'timeout') {
    el.innerHTML = \`
      <div class="login-status">
        <p class="text-error">Login timed out. Please try again.</p>
      </div>
    \`;
  }
}

// ── Step 2: Adapter Selection ──────────────

function renderAdapters(el) {
  if (registryAdapters.length === 0) {
    el.innerHTML = \`
      <h2>Select Adapters</h2>
      <div class="subtitle">Loading available adapters from registry...</div>
      <div style="text-align: center; padding: 40px;">
        <div class="spinner spinner-lg"></div>
      </div>
    \`;
    return;
  }

  // Pre-select popular on first render
  if (selectedAdapters.size === 0) {
    for (const a of registryAdapters) {
      if (POPULAR.includes(a.name)) {
        selectedAdapters.add(a.name);
      }
    }
  }

  let cards = '';
  for (const a of registryAdapters) {
    const sel = selectedAdapters.has(a.name) ? 'selected' : '';
    cards += \`
      <div class="adapter-card \${sel}" onclick="toggleAdapter('\${a.name}')">
        <div class="check">\${sel ? '\\u2713' : ''}</div>
        <div class="adapter-name">\${a.name}</div>
        <div class="adapter-desc">\${a.description || ''}</div>
      </div>
    \`;
  }

  el.innerHTML = \`
    <h2>Select Adapters</h2>
    <div class="subtitle">Choose the APIs you want to connect. You can add more later.</div>
    <div class="card-grid">\${cards}</div>
    <div class="btn-row-right">
      <button class="btn btn-ghost" onclick="selectedAdapters.clear(); renderStep()">Clear all</button>
      <button class="btn btn-primary" onclick="installSelected()" id="installBtn"
        \${selectedAdapters.size === 0 ? 'disabled' : ''}>
        Install \${selectedAdapters.size} adapter\${selectedAdapters.size !== 1 ? 's' : ''} \\u2192
      </button>
    </div>
    <div id="installStatus"></div>
  \`;
}

function toggleAdapter(name) {
  if (selectedAdapters.has(name)) {
    selectedAdapters.delete(name);
  } else {
    selectedAdapters.add(name);
  }
  renderStep();
}

function installSelected() {
  const adapters = [...selectedAdapters];
  installedAdapters = adapters;

  // Replace button with progress
  const statusEl = document.getElementById('installStatus');
  statusEl.innerHTML = '<div class="spacer"></div><div class="section-title">Installing</div><div class="card-list" id="installList"></div>';

  const list = document.getElementById('installList');
  for (const a of adapters) {
    list.innerHTML += \`
      <div class="proof-card" id="install-\${a}">
        <div class="proof-icon"><div class="spinner"></div></div>
        <div class="proof-info" style="flex:1; min-width:0;">
          <div class="proof-name">\${a}</div>
          <div class="proof-output">Connecting to registry...</div>
          <div class="log-buffer" id="log-\${a}"></div>
        </div>
      </div>
    \`;
  }

  // Disable install button
  const btn = document.getElementById('installBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Installing...'; }

  vscode.postMessage({ type: 'install-adapters', adapters });
}

function handleInstallProgress(msg) {
  const card = document.getElementById('install-' + msg.adapter);
  if (!card) return;

  // Update log buffer
  const logEl = document.getElementById('log-' + msg.adapter);
  if (logEl && msg.logs && msg.logs.length > 0) {
    logEl.innerHTML = msg.logs
      .map(l => '<div class="log-line">' + escapeHtml(l) + '</div>')
      .join('');
  }

  if (msg.status === 'installing') {
    card.querySelector('.proof-output').textContent = msg.message;
  } else if (msg.status === 'success') {
    card.className = 'proof-card success';
    card.querySelector('.proof-icon').innerHTML = '<span class="text-success">\\u2713</span>';
    card.querySelector('.proof-output').textContent = msg.message;
    if (logEl) logEl.style.display = 'none';
  } else if (msg.status === 'error') {
    card.className = 'proof-card error';
    card.querySelector('.proof-icon').innerHTML = '<span class="text-error">\\u2717</span>';
    card.querySelector('.proof-output').textContent = msg.message;
  }

  // Check if all done
  const allCards = document.querySelectorAll('[id^="install-"]');
  const allDone = [...allCards].every(c => c.classList.contains('success') || c.classList.contains('error'));
  if (allDone) {
    const statusEl = document.getElementById('installStatus');
    statusEl.innerHTML += \`
      <div class="btn-row-right">
        <button class="btn btn-primary" onclick="next()">Continue \\u2192</button>
      </div>
    \`;
  }
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Step 3: Configure Auth ─────────────────

function renderAuth(el) {
  el.innerHTML = \`
    <h2>Configure Authentication</h2>
    <div class="subtitle">Set up API tokens for your installed adapters.</div>
    <div id="tokenList" style="text-align: center; padding: 32px;">
      <div class="spinner spinner-lg"></div>
      <p class="muted" style="margin-top: 12px;">Detecting token requirements...</p>
    </div>
  \`;

  vscode.postMessage({ type: 'load-token-requirements' });
}

function renderTokenStep(vaultTokens) {
  const el = document.getElementById('tokenList');
  if (!el) return;

  const vaultMap = {};
  for (const vt of vaultTokens) {
    vaultMap[vt.name] = vt;
  }

  if (tokenRequirements.length === 0) {
    el.innerHTML = \`
      <div style="text-align: center; padding: 24px;">
        <p class="muted">No tokens required for installed adapters.</p>
      </div>
      <div class="btn-row-right">
        <button class="btn btn-primary" onclick="next()">Continue \\u2192</button>
      </div>
    \`;
    return;
  }

  let html = '';

  // Vault pull option — always show so user can re-pull if needed
  html += \`
    <div class="card" style="margin-bottom: 20px; display: flex; align-items: center; gap: 16px; padding: 16px 20px;">
      <div style="font-size: 24px;">\\u{1F512}</div>
      <div style="flex: 1;">
        <div style="font-weight: 500;">Pull from Vault</div>
        <div class="muted">Restore encrypted tokens from the dex registry vault.</div>
      </div>
      <button class="btn btn-secondary" onclick="pullVault()">Pull Vault</button>
    </div>
    <div id="vaultPullStatus"></div>
  \`;

  html += '<div class="card-list">';
  for (const req of tokenRequirements) {
    const fromVault = vaultMap[req.env_var];
    const configured = req.configured || !!fromVault;
    const cls = configured ? 'configured' : '';

    if (req.is_oauth) {
      const oauthExpanded = !configured;
      html += \`
        <div class="token-card \${cls}" id="token-\${req.env_var}">
          <div class="token-header">
            <span class="token-name">\${req.env_var}</span>
            \${configured
              ? '<span class="status-badge success">\\u2713 Configured</span>'
              : '<span class="status-badge pending">OAuth required</span>'}
          </div>
          <div class="token-adapters">Used by: \${req.adapters.join(', ')}</div>
          \${fromVault && !req.configured ? '<div class="muted" style="margin-bottom:8px;">\\u2713 Found in vault</div>' : ''}
          \${configured ? \`
            <div style="margin-top: 8px;">
              <a href="#" class="btn-link" onclick="event.preventDefault(); toggleOAuthReconfigure('\${req.env_var}')">
                Reconfigure OAuth (token may be expired)
              </a>
            </div>
          \` : ''}
          <div id="oauth-body-\${req.env_var}" style="\${oauthExpanded ? '' : 'display:none;'}">
            <div class="muted" style="margin-top: 12px; margin-bottom: 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;">Select OAuth Scopes</div>
            <div class="scope-grid" id="scopes-\${req.env_var}">
              <label class="scope-chip selected" onclick="toggleScope(this)">
                <input type="checkbox" value="gmail.readonly" checked>
                <div class="scope-check">\\u2713</div>
                <div>
                  <div class="scope-label">Gmail Read</div>
                  <div class="scope-desc">Read messages & labels</div>
                </div>
              </label>
              <label class="scope-chip" onclick="toggleScope(this)">
                <input type="checkbox" value="gmail.compose">
                <div class="scope-check">\\u2713</div>
                <div>
                  <div class="scope-label">Gmail Compose</div>
                  <div class="scope-desc">Draft & send emails</div>
                </div>
              </label>
              <label class="scope-chip selected" onclick="toggleScope(this)">
                <input type="checkbox" value="gmail.send" checked>
                <div class="scope-check">\\u2713</div>
                <div>
                  <div class="scope-label">Gmail Send</div>
                  <div class="scope-desc">Send on your behalf</div>
                </div>
              </label>
              <label class="scope-chip selected" onclick="toggleScope(this)">
                <input type="checkbox" value="calendar" checked>
                <div class="scope-check">\\u2713</div>
                <div>
                  <div class="scope-label">Calendar</div>
                  <div class="scope-desc">Read & write events</div>
                </div>
              </label>
              <label class="scope-chip" onclick="toggleScope(this)">
                <input type="checkbox" value="drive.readonly">
                <div class="scope-check">\\u2713</div>
                <div>
                  <div class="scope-label">Drive</div>
                  <div class="scope-desc">Read files from Drive</div>
                </div>
              </label>
            </div>
            <button class="btn btn-primary" onclick="startOAuth('\${req.env_var}')">
              Configure Google OAuth \\u2192
            </button>
            <div id="oauth-status-\${req.env_var}"></div>
          </div>
        </div>
      \`;
    } else {
      const urlHtml = req.url
        ? '<a href="' + req.url + '" style="color:var(--accent);font-size:11px;text-decoration:none;" title="Open in browser">Get token \\u2197</a>'
        : '';

      html += \`
        <div class="token-card \${cls}" id="token-\${req.env_var}">
          <div class="token-header">
            <span class="token-name">\${req.env_var}</span>
            <span>\${configured
              ? '<span class="status-badge success">\\u2713 Configured</span>'
              : urlHtml}</span>
          </div>
          <div class="token-adapters">Used by: \${req.adapters.join(', ')}</div>
          \${fromVault && !req.configured ? '<div class="muted" style="margin-bottom:8px;">\\u2713 Found in vault</div>' : ''}
          \${configured ? \`
            <div style="margin-top: 6px;">
              <a href="#" class="btn-link" onclick="event.preventDefault(); toggleTokenReconfigure('\${req.env_var}', '\${req.url || ''}')">
                Reconfigure token
              </a>
            </div>
            <div id="token-body-\${req.env_var}" style="display:none; margin-top:8px;">
              <div class="token-input-row">
                <input type="password" class="token-input" id="input-\${req.env_var}"
                  placeholder="Paste new \${req.env_var} token">
                <button class="btn btn-primary" onclick="setToken('\${req.env_var}')">Set</button>
              </div>
            </div>
          \` : \`
            <div class="token-input-row">
              <input type="password" class="token-input" id="input-\${req.env_var}"
                placeholder="Paste your \${req.env_var} token here">
              <button class="btn btn-primary" onclick="setToken('\${req.env_var}')">Set</button>
            </div>
          \`}
        </div>
      \`;
    }
  }
  html += '</div>';

  html += \`
    <div class="btn-row-right">
      <button class="btn btn-ghost" onclick="next()">Skip remaining</button>
      <button class="btn btn-primary" onclick="next()">Continue \\u2192</button>
    </div>
  \`;

  el.innerHTML = html;
}

function pullVault() {
  vscode.postMessage({ type: 'vault-pull' });
  const statusEl = document.getElementById('vaultPullStatus');
  if (statusEl) {
    statusEl.innerHTML = \`
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;">
        <div class="spinner"></div>
        <span class="muted">Pulling vault...</span>
      </div>
    \`;
  }
}

function handleVaultPullStatus(msg) {
  const statusEl = document.getElementById('vaultPullStatus');
  if (!statusEl) return;

  if (msg.success) {
    statusEl.innerHTML = \`
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;" class="text-success">
        \\u2713 \${msg.message}
      </div>
    \`;
    // Token requirements will be refreshed via a follow-up message
  } else {
    statusEl.innerHTML = \`
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;" class="text-error">
        \\u2717 \${msg.message}
      </div>
    \`;
  }
}

function setToken(envVar) {
  const input = document.getElementById('input-' + envVar);
  if (!input || !input.value.trim()) return;
  vscode.postMessage({ type: 'configure-token', env_var: envVar, value: input.value.trim() });
}

function handleTokenStatus(msg) {
  const card = document.getElementById('token-' + msg.env_var);
  if (!card) return;

  if (msg.configured) {
    card.classList.add('configured');
    const header = card.querySelector('.token-header');
    // Replace status badge
    const badge = header.querySelector('.status-badge');
    if (badge) {
      badge.className = 'status-badge success';
      badge.innerHTML = '\\u2713 Configured';
    } else {
      header.innerHTML += '<span class="status-badge success">\\u2713 Configured</span>';
    }
    // Hide input row
    const inputRow = card.querySelector('.token-input-row');
    if (inputRow) inputRow.style.display = 'none';
  }
}

function toggleOAuthReconfigure(envVar) {
  const body = document.getElementById('oauth-body-' + envVar);
  if (body) {
    body.style.display = body.style.display === 'none' ? '' : 'none';
  }
}

function toggleTokenReconfigure(envVar, url) {
  const body = document.getElementById('token-body-' + envVar);
  if (body) {
    body.style.display = body.style.display === 'none' ? '' : 'none';
  }
}

function toggleScope(chip) {
  const cb = chip.querySelector('input[type="checkbox"]');
  cb.checked = !cb.checked;
  chip.classList.toggle('selected', cb.checked);
}

function startOAuth(envVar) {
  const scopeContainer = document.getElementById('scopes-' + envVar);
  const checkboxes = scopeContainer.querySelectorAll('input[type="checkbox"]:checked');
  const scopes = [...checkboxes].map(cb => cb.value);
  if (scopes.length === 0) {
    alert('Select at least one scope');
    return;
  }
  vscode.postMessage({ type: 'oauth-setup-google', scopes });
}

function handleOAuthStatus(msg) {
  // Find any visible oauth status element
  const els = document.querySelectorAll('[id^="oauth-status-"]');
  for (const el of els) {
    if (msg.status === 'starting' || msg.status === 'in-progress') {
      el.innerHTML = \`
        <div style="margin-top: 12px; display: flex; align-items: center; gap: 8px;">
          <div class="spinner"></div>
          <span class="muted">\${msg.message}</span>
        </div>
      \`;
    } else if (msg.status === 'success') {
      el.innerHTML = '<div style="margin-top: 12px;" class="text-success">\\u2713 ' + msg.message + '</div>';
      // Mark the card as configured
      const card = el.closest('.token-card');
      if (card) card.classList.add('configured');
    } else if (msg.status === 'error') {
      el.innerHTML = '<div style="margin-top: 12px;" class="text-error">\\u2717 ' + msg.message + '</div>';
    }
  }
}

// ── Step 4: Wire AI Tools ──────────────────

function renderWire(el) {
  // Pre-select first client on first render
  if (selectedWireClients.size === 0) {
    selectedWireClients.add(WIRE_CLIENTS[0].id);
  }

  let cards = '';
  for (const c of WIRE_CLIENTS) {
    const sel = selectedWireClients.has(c.id) ? 'selected' : '';
    cards += \`
      <div class="wire-card \${sel}" onclick="toggleWire('\${c.id}')">
        <div class="wire-icon">\${c.icon}</div>
        <div class="wire-info">
          <div class="wire-name">\${c.name}</div>
          <div class="wire-desc">\${c.desc}</div>
        </div>
        <div class="wire-check">\${sel ? '\\u2713' : ''}</div>
      </div>
    \`;
  }

  const stdioServers = [
    { name: 'Playwright (headed)', desc: 'Browser automation — visible Chrome window' },
    { name: 'Playwright (headless)', desc: 'Browser automation — invisible, for CI/scripts' },
    { name: 'Chrome DevTools (headed)', desc: 'Chrome DevTools protocol — visible' },
    { name: 'Chrome DevTools (headless)', desc: 'Chrome DevTools protocol — headless' },
    { name: 'Filesystem', desc: 'Read/write files in /tmp sandbox' },
  ];
  let stdioHtml = '';
  for (const s of stdioServers) {
    stdioHtml += \`
      <div style="display:flex; align-items:center; gap:10px; padding:6px 0;">
        <div style="color:var(--success); font-size:13px; flex-shrink:0;">\\u2713</div>
        <div>
          <div style="font-size:13px; font-weight:500;">\${s.name}</div>
          <div class="muted" style="font-size:11px;">\${s.desc}</div>
        </div>
      </div>
    \`;
  }

  el.innerHTML = \`
    <h2>Wire AI Tools</h2>
    <div class="subtitle">Install dex skills into your preferred AI coding tools.</div>
    <div class="card-list">\${cards}</div>

    <div style="margin-top: 28px;">
      <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;" class="muted">Included: Standard MCP Bundle</div>
      <div class="card" style="padding:16px 20px;">
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px;">
          <div style="font-size:20px;">\\u{1F4E6}</div>
          <div>
            <div style="font-weight:500;">Stdio MCP Servers</div>
            <div class="muted" style="font-size:12px;">Auto-configured during setup — browser automation, DevTools, and filesystem access.</div>
          </div>
        </div>
        <div style="border-top:1px solid var(--card-border); padding-top:10px;">
          \${stdioHtml}
        </div>
      </div>
    </div>

    <div class="btn-row-right" id="wireActions">
      <button class="btn btn-ghost" onclick="next()">Skip</button>
      <button class="btn btn-primary" onclick="wireSelected()"
        \${selectedWireClients.size === 0 ? 'disabled' : ''}>
        Wire \${selectedWireClients.size} tool\${selectedWireClients.size !== 1 ? 's' : ''} \\u2192
      </button>
    </div>
    <div id="wireStatus"></div>
  \`;
}

function toggleWire(id) {
  if (selectedWireClients.has(id)) {
    selectedWireClients.delete(id);
  } else {
    selectedWireClients.add(id);
  }
  renderStep();
}

function wireSelected() {
  const clients = [...selectedWireClients];
  const actions = document.getElementById('wireActions');
  if (actions) actions.style.display = 'none';

  const statusEl = document.getElementById('wireStatus');
  statusEl.innerHTML = '<div class="spacer"></div><div class="section-title">Wiring</div><div class="card-list" id="wireList"></div>';

  const list = document.getElementById('wireList');
  for (const c of clients) {
    const def = WIRE_CLIENTS.find(w => w.id === c);
    list.innerHTML += \`
      <div class="proof-card" id="wire-\${c}">
        <div class="proof-icon"><div class="spinner"></div></div>
        <div class="proof-info">
          <div class="proof-name">\${def ? def.name : c}</div>
          <div class="proof-output">Wiring...</div>
        </div>
      </div>
    \`;
  }

  vscode.postMessage({ type: 'wire-clients', clients });
}

function handleWireProgress(msg) {
  const card = document.getElementById('wire-' + msg.client);
  if (!card) return;

  if (msg.status === 'success') {
    card.className = 'proof-card success';
    card.querySelector('.proof-icon').innerHTML = '<span class="text-success">\\u2713</span>';
    card.querySelector('.proof-output').textContent = 'Connected';
  } else if (msg.status === 'error') {
    card.className = 'proof-card error';
    card.querySelector('.proof-icon').innerHTML = '<span class="text-error">\\u2717</span>';
    card.querySelector('.proof-output').textContent = 'Failed';
  }

  const allCards = document.querySelectorAll('[id^="wire-"]');
  const allDone = [...allCards].every(c => c.classList.contains('success') || c.classList.contains('error'));
  if (allDone) {
    const statusEl = document.getElementById('wireStatus');
    statusEl.innerHTML += \`
      <div class="btn-row-right">
        <button class="btn btn-primary" onclick="next()">Continue \\u2192</button>
      </div>
    \`;
  }
}

// ── Step 5: Proof of Life ──────────────────

function renderProof(el) {
  const adapters = installedAdapters.length > 0 ? installedAdapters : [];

  if (adapters.length === 0) {
    el.innerHTML = \`
      <h2>Verification</h2>
      <div class="subtitle">No adapters to verify. You can add adapters later.</div>
      <div class="btn-row-right">
        <button class="btn btn-primary" onclick="next()">Finish Setup \\u2192</button>
      </div>
    \`;
    return;
  }

  let cards = '';
  for (const a of adapters) {
    cards += \`
      <div class="proof-card" id="proof-\${a}">
        <div class="proof-icon"><div class="spinner"></div></div>
        <div class="proof-info">
          <div class="proof-name">\${a}</div>
          <div class="proof-output">Running proof-of-life...</div>
        </div>
      </div>
    \`;
  }

  el.innerHTML = \`
    <h2>Verification</h2>
    <div class="subtitle">Running proof-of-life checks on your configured adapters.</div>
    <div class="card-list">\${cards}</div>
    <div id="proofActions"></div>
  \`;

  vscode.postMessage({ type: 'run-proof-of-life', adapters });
}

function handleProofResult(msg) {
  const card = document.getElementById('proof-' + msg.adapter);
  if (!card) return;

  proofResults[msg.adapter] = msg;

  if (msg.status === 'success') {
    card.className = 'proof-card success';
    card.querySelector('.proof-icon').innerHTML = '<span class="text-success">\\u2713</span>';
    const lines = (msg.output || '').split('\\n').filter(l => l.trim());
    if (lines.length > 0) {
      const html = lines.map(l => {
        const truncated = l.length > 80 ? l.slice(0, 77) + '...' : l;
        const escaped = truncated.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return '<span class="proof-line">' + escaped + '</span>';
      }).join('');
      card.querySelector('.proof-output').innerHTML = '<div class="proof-summary">' + html + '</div>';
    } else {
      card.querySelector('.proof-output').innerHTML = '<div class="proof-summary"><span class="proof-line">Verified</span></div>';
    }
  } else if (msg.status === 'error') {
    card.className = 'proof-card error';
    card.querySelector('.proof-icon').innerHTML = '<span class="text-error">\\u2717</span>';
    const errText = (msg.error || 'Check failed').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    card.querySelector('.proof-output').innerHTML = '<div class="proof-summary"><span class="proof-line">' + errText + '</span></div>' +
      '<div class="proof-error-hint">Run: dex powerpack credentials</div>';
  }

  const allCards = document.querySelectorAll('[id^="proof-"]');
  const allDone = [...allCards].every(c => c.classList.contains('success') || c.classList.contains('error'));
  if (allDone) {
    const el = document.getElementById('proofActions');
    el.innerHTML = \`
      <div class="btn-row-right">
        <button class="btn btn-primary" onclick="next()">Complete Setup \\u2192</button>
      </div>
    \`;
  }
}

// ── Step 6: Complete ───────────────────────

function renderComplete(el) {
  const adapterCount = installedAdapters.length;
  const tokenCount = tokenRequirements.filter(t => t.configured).length;
  const wireCount = selectedWireClients.size;

  el.innerHTML = \`
    <div class="complete-hero">
      <h1>You're all set!</h1>
      <div class="subtitle">dex is configured and ready to go.</div>
    </div>
    <div class="summary-grid">
      <div class="summary-card">
        <div class="summary-number">\${adapterCount}</div>
        <div class="summary-label">Adapters installed</div>
      </div>
      <div class="summary-card">
        <div class="summary-number">\${tokenCount}</div>
        <div class="summary-label">Tokens configured</div>
      </div>
      <div class="summary-card">
        <div class="summary-number">\${wireCount}</div>
        <div class="summary-label">Tools wired</div>
      </div>
    </div>
    <div style="text-align: center;">
      <button class="btn btn-primary" onclick="finishSetup()">
        Open dex \\u2192
      </button>
    </div>
  \`;
}

function finishSetup() {
  vscode.postMessage({ type: 'complete-setup' });
}

// ── Init ───────────────────────────────────

renderStep();
`;
