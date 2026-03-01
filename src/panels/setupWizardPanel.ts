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
      case "vault-pull-with-passphrase": {
        const passphrase = msg.passphrase as string;
        if (!passphrase) {
          panel.webview.postMessage({ type: "vault-pull-status", success: false, message: "No passphrase provided" });
          break;
        }
        const pullOk = await client.vaultPull(passphrase);
        if (pullOk) {
          callbacks.onTokensConfigured?.();
          // Reload token requirements first, then send vault status
          // (sending status last prevents it being wiped by re-render)
          const freshReqs = await client.detectTokenRequirements();
          const freshVault = await client.vaultTokenList();
          panel.webview.postMessage({
            type: "token-requirements",
            requirements: freshReqs,
            vaultTokens: freshVault,
          });
          // Send status AFTER re-render so the DOM element exists
          panel.webview.postMessage({
            type: "vault-pull-status",
            success: true,
            message: "Vault pulled — tokens restored",
          });
        } else {
          panel.webview.postMessage({
            type: "vault-pull-status",
            success: false,
            message: "Vault pull failed. Check passphrase.",
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
/* ── Design tokens ───────────────────────── */

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
  --glow-color: 79, 193, 255;
  --glow-success: 78, 201, 176;
}

body.vscode-light {
  --glow-color: 56, 100, 180;
  --glow-success: 30, 140, 110;
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
  transition: opacity 0.3s ease;
}

body.dimmed .wizard { opacity: 0.35; pointer-events: none; }

/* ── Animations ──────────────────────────── */

@keyframes spin { to { transform: rotate(360deg); } }

@keyframes pulse-ring {
  0%   { box-shadow: 0 0 0 0px rgba(var(--glow-color), 0.45); }
  70%  { box-shadow: 0 0 0 7px rgba(var(--glow-color), 0); }
  100% { box-shadow: 0 0 0 0px rgba(var(--glow-color), 0); }
}

@keyframes line-fill {
  from { background-position: -200% 0; }
  to   { background-position: 200% 0; }
}

@keyframes step-enter {
  from { opacity: 0; transform: translateX(20px); }
  to   { opacity: 1; transform: translateX(0); }
}

@keyframes step-exit {
  from { opacity: 1; transform: translateX(0); }
  to   { opacity: 0; transform: translateX(-12px); }
}

@keyframes check-pop {
  0%   { transform: scale(0.2) rotate(-8deg); opacity: 0; }
  60%  { transform: scale(1.18) rotate(2deg); opacity: 1; }
  100% { transform: scale(1) rotate(0); opacity: 1; }
}

@keyframes success-ripple {
  0%   { box-shadow: 0 0 0 0px rgba(var(--glow-success), 0.5); }
  100% { box-shadow: 0 0 0 14px rgba(var(--glow-success), 0); }
}

@keyframes hue-drift {
  0%   { filter: drop-shadow(0 0 14px rgba(var(--glow-color), 0.5)); }
  50%  { filter: drop-shadow(0 0 22px rgba(var(--glow-color), 0.8)); }
  100% { filter: drop-shadow(0 0 14px rgba(var(--glow-color), 0.5)); }
}

@keyframes blink {
  0%, 100% { opacity: 0.8; }
  50%      { opacity: 0; }
}

@keyframes overlay-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}

@keyframes modal-in {
  from { opacity: 0; transform: scale(0.92) translateY(10px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}

@keyframes bounce-up {
  0%, 100% { transform: translateY(0); }
  40%      { transform: translateY(-5px); }
  70%      { transform: translateY(-2px); }
}

@keyframes stagger-in {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}

@keyframes breathe {
  0%, 100% { opacity: 0.4; }
  50%      { opacity: 1; }
}

@keyframes top-pulse {
  0%, 100% { opacity: 0.5; }
  50%      { opacity: 1; }
}

/* ── Progress bar ────────────────────────── */

.progress-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  margin-bottom: 56px;
  padding: 0 16px;
}

.progress-step { display: flex; align-items: center; }

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
  transition: all 0.35s ease;
  flex-shrink: 0;
  position: relative;
}

.progress-dot.active {
  border-color: var(--accent);
  color: var(--accent);
  animation: pulse-ring 2s ease-out infinite;
}

.progress-dot.done {
  border-color: var(--success);
  background: var(--success);
  color: #000;
}

.progress-dot[data-label]::after {
  content: attr(data-label);
  position: absolute;
  top: 34px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0.04em;
  white-space: nowrap;
  color: var(--border);
  transition: color 0.3s ease;
}

.progress-dot.active[data-label]::after { color: var(--accent); }
.progress-dot.done[data-label]::after   { color: var(--success); }

.progress-line {
  width: 36px;
  height: 2px;
  background: var(--border);
  transition: background 0.4s ease;
  overflow: hidden;
}

.progress-line.done { background: var(--success); }

.progress-line.filling {
  background: linear-gradient(90deg, var(--border), var(--accent), var(--border));
  background-size: 200% 100%;
  animation: line-fill 0.8s ease forwards;
}

/* ── Step container ──────────────────────── */

.step-container { min-height: 200px; }
.step-container.entering { animation: step-enter 0.3s cubic-bezier(0.16, 1, 0.3, 1); }
.step-container.exiting  { animation: step-exit 0.18s ease-in forwards; }

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
  opacity: 0.6;
  font-size: 14px;
  margin-bottom: 32px;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  opacity: 0.5;
  margin-bottom: 16px;
}

/* ── Buttons ─────────────────────────────── */

.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 24px;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  font-family: inherit;
}

.btn:active { transform: scale(0.97); }

.btn-primary {
  background: var(--btn-bg);
  color: var(--btn-fg);
}

.btn-primary:hover { background: var(--btn-hover); }

.btn-primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  transform: none;
}

.btn-primary.loading {
  opacity: 0.7;
  cursor: wait;
}

.btn-primary.loading::after {
  content: '';
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255,255,255,0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  margin-left: 4px;
}

.btn-secondary {
  background: var(--btn-secondary-bg);
  color: var(--btn-secondary-fg);
}

.btn-secondary:hover { opacity: 0.85; }

.btn-ghost {
  background: transparent;
  color: var(--accent);
  padding: 10px 16px;
}

.btn-ghost:hover { opacity: 0.7; }

.btn-link {
  color: var(--accent);
  font-size: 12px;
  text-decoration: none;
  cursor: pointer;
  opacity: 0.75;
  background: none;
  border: none;
  font-family: inherit;
}

.btn-link:hover { text-decoration: underline; opacity: 1; }

.btn-row { display: flex; gap: 12px; margin-top: 24px; }
.btn-row-right { display: flex; gap: 12px; margin-top: 24px; justify-content: flex-end; }

/* ── Glow card system ────────────────────── */

.glow-card {
  position: relative;
  overflow: hidden;
}

.glow-card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(
    140px circle at var(--mx, 50%) var(--my, 50%),
    rgba(var(--glow-color), 0.1),
    transparent 70%
  );
  opacity: 0;
  transition: opacity 0.3s ease;
  pointer-events: none;
  border-radius: inherit;
}

.glow-card:hover::before { opacity: 1; }

.glow-card:hover {
  border-color: rgba(var(--glow-color), 0.5);
  box-shadow: 0 0 24px rgba(var(--glow-color), 0.06);
}

/* ── Cards ───────────────────────────────── */

.card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 8px;
  padding: 24px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
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
  transform: translateY(-3px);
  box-shadow: 0 8px 24px rgba(0,0,0,0.15);
}

.provider-card .icon {
  width: 48px;
  height: 48px;
  margin: 0 auto 14px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.provider-card .icon svg { width: 40px; height: 40px; }

.provider-card .name {
  font-size: 15px;
  font-weight: 500;
  margin-bottom: 4px;
}

.provider-card .hint {
  font-size: 12px;
  opacity: 0.5;
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

.adapter-card.selected {
  border-color: var(--accent);
  background: rgba(var(--glow-color), 0.04);
}

.adapter-card .check {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 18px;
  height: 18px;
  border: 2px solid var(--border);
  border-radius: 4px;
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
  animation: check-pop 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}

.adapter-card .adapter-name {
  font-weight: 500;
  margin-bottom: 2px;
  padding-right: 28px;
}

.adapter-card .adapter-desc {
  font-size: 11px;
  opacity: 0.55;
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
  padding: 16px 24px;
}

.token-card.configured { border-color: var(--success); }

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
  opacity: 0.5;
  margin-bottom: 10px;
}

.token-input-row { display: flex; gap: 8px; }

.token-input {
  flex: 1;
  padding: 8px 12px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 6px;
  color: var(--input-fg);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.token-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(var(--glow-color), 0.12);
}

/* ── Wire client cards ───────────────────── */

.wire-card {
  background: var(--card-bg);
  border: 2px solid var(--card-border);
  border-radius: 8px;
  padding: 16px 24px;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  gap: 16px;
}

.wire-card.selected {
  border-color: var(--accent);
  background: rgba(var(--glow-color), 0.04);
}

.wire-icon {
  font-size: 24px;
  flex-shrink: 0;
  width: 32px;
  text-align: center;
  opacity: 0.8;
}

.wire-info { flex: 1; }
.wire-name { font-weight: 500; font-size: 14px; }
.wire-desc { font-size: 12px; opacity: 0.5; }

.wire-check {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border);
  border-radius: 4px;
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
  animation: check-pop 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}

/* ── Proof of life ───────────────────────── */

/* ── Install proof cards (reused for adapter install) ── */
.proof-card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  transition: border-color 0.3s ease, box-shadow 0.3s ease;
}
.proof-card.success { border-color: var(--success); }
.proof-card.error { border-color: var(--error); }
.proof-icon { font-size: 20px; flex-shrink: 0; width: 28px; text-align: center; padding-top: 2px; }
.proof-info { flex: 1; min-width: 0; }
.proof-name { font-weight: 500; margin-bottom: 2px; }

/* ── Vault card ─────────────────────────── */
.vault-card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 10px;
  padding: 16px 20px;
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
  transition: border-color 0.3s, box-shadow 0.3s;
}
.vault-card.vault-success { border-color: var(--success); }
.vault-icon { opacity: 0.6; flex-shrink: 0; }
.vault-body { flex: 1; }
.vault-title { font-weight: 500; margin-bottom: 2px; }
.vault-desc { font-size: 12px; }
.btn-success-done { opacity: 0.5; cursor: default; }

.vault-status-banner {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 8px;
  margin-bottom: 16px;
  animation: step-enter-forward 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}
.vault-status-banner.success { background: rgba(var(--glow-success), 0.08); border: 1px solid rgba(var(--glow-success), 0.2); }
.vault-status-banner.error { background: rgba(241, 76, 76, 0.08); border: 1px solid rgba(241, 76, 76, 0.2); }
.vault-status-title { font-weight: 500; font-size: 13px; }
.vault-status-hint { font-size: 11px; margin-top: 2px; }

/* ── Verification cards ─────────────────── */
.verify-list { display: flex; flex-direction: column; gap: 12px; }
.verify-counter {
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.04em;
  opacity: 0.6;
  margin-bottom: 16px;
  transition: opacity 0.3s, color 0.3s;
}
.verify-counter.text-success { opacity: 1; }
.verify-counter.text-warning { opacity: 1; color: var(--warning); }

.verify-card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 10px;
  overflow: hidden;
  transition: border-color 0.3s ease, box-shadow 0.3s ease;
}
.verify-card.success {
  border-color: var(--success);
  box-shadow: 0 0 0 1px rgba(var(--glow-success), 0.1);
  animation: success-ripple 0.6s ease-out;
}
.verify-card.error {
  border-color: var(--error);
  box-shadow: 0 0 0 1px rgba(241, 76, 76, 0.1);
}

.verify-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
}
.verify-status-dot { flex-shrink: 0; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; }
.verify-adapter-name { font-weight: 600; font-size: 14px; flex: 1; }
.verify-badge {
  font-size: 11px;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: 10px;
  background: rgba(128, 128, 128, 0.12);
  color: var(--fg);
  opacity: 0.6;
  flex-shrink: 0;
}
.verify-badge.success { background: rgba(var(--glow-success), 0.12); color: var(--success); opacity: 1; }
.verify-badge.error { background: rgba(241, 76, 76, 0.12); color: var(--error); opacity: 1; }

.verify-body {
  padding: 0 16px 14px 44px; /* 16px + 18px dot + 10px gap = 44px left indent */
}

.verify-running { font-size: 12px; }

.verify-result-header {
  font-size: 12px;
  font-weight: 500;
  opacity: 0.8;
  margin-bottom: 6px;
}

.verify-detail-list {
  font-size: 11px;
  font-family: var(--vscode-editor-font-family, monospace);
  line-height: 1.7;
  opacity: 0.6;
  border-left: 2px solid var(--success);
  padding-left: 10px;
  max-height: 120px;
  overflow-y: auto;
}
.verify-card.error .verify-detail-list { border-left-color: var(--error); }

.verify-detail-item {
  white-space: pre-wrap;
  word-break: break-word;
}

.verify-error-msg {
  font-size: 12px;
  font-family: var(--vscode-editor-font-family, monospace);
  color: var(--error);
  opacity: 0.85;
  border-left: 2px solid var(--error);
  padding-left: 10px;
  margin-bottom: 8px;
}

.verify-error-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  opacity: 0.5;
}
.verify-error-hint code {
  background: rgba(128, 128, 128, 0.15);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
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

.status-badge.success { background: rgba(var(--glow-success), 0.12); color: var(--success); }
.status-badge.error   { background: rgba(241, 76, 76, 0.12); color: var(--error); }
.status-badge.pending { background: rgba(204, 167, 0, 0.12); color: var(--warning); }

/* ── Spinner ─────────────────────────────── */

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  display: inline-block;
}

.spinner-lg { width: 24px; height: 24px; }

/* ── Breathing dot (replaces spinner for subtle states) */

.dot-breathe {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  animation: breathe 1.4s ease-in-out infinite;
  display: inline-block;
}

/* ── Welcome hero ────────────────────────── */

.hero {
  text-align: center;
  padding: 40px 0 24px;
}

.hero-logo {
  display: inline-block;
  margin-bottom: 20px;
  animation: hue-drift 4s ease-in-out infinite;
}

.hero-logo svg {
  width: 120px;
  height: 120px;
  color: var(--fg);
}

body.vscode-light .hero-logo { filter: drop-shadow(0 0 16px rgba(56, 100, 180, 0.4)); }

.hero h1 {
  font-size: 32px;
  font-weight: 300;
  letter-spacing: -0.5px;
}

.hero .tagline {
  font-size: 15px;
  opacity: 0.45;
  margin: 8px 0 36px;
}

/* ── Complete screen ─────────────────────── */

.complete-hero {
  text-align: center;
  padding: 32px 0 8px;
}

.complete-logo {
  display: inline-block;
  margin-bottom: 12px;
  animation: hue-drift 4s ease-in-out infinite;
}

.complete-logo svg { width: 48px; height: 48px; color: var(--success); }

.complete-hero h1 { color: var(--success); }

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
  padding: 24px 16px;
  text-align: center;
  opacity: 0;
  animation: stagger-in 0.4s ease forwards;
}

.summary-card:nth-child(1) { animation-delay: 0.1s; }
.summary-card:nth-child(2) { animation-delay: 0.2s; }
.summary-card:nth-child(3) { animation-delay: 0.3s; }

.summary-number {
  font-size: 28px;
  font-weight: 300;
  color: var(--accent);
  margin-bottom: 4px;
}

.summary-label { font-size: 12px; opacity: 0.5; }

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
  position: relative;
  overflow: hidden;
}

.scope-chip:hover { border-color: rgba(var(--glow-color), 0.4); }

.scope-chip.selected {
  border-color: var(--accent);
  background: rgba(var(--glow-color), 0.06);
}

.scope-chip input[type="checkbox"] { display: none; }

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
  animation: check-pop 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}

.scope-label { font-size: 13px; font-weight: 500; }
.scope-desc { font-size: 11px; opacity: 0.5; line-height: 1.3; }

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

/* ── Log buffer (terminal style) ─────────── */

.log-buffer {
  margin-top: 8px;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 4px;
  border-left: 2px solid var(--accent);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
  line-height: 1.6;
  max-height: 60px;
  overflow: hidden;
}

.log-buffer .log-line { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.log-buffer .log-line:nth-last-child(3) { opacity: 0.25; }
.log-buffer .log-line:nth-last-child(2) { opacity: 0.5; }
.log-buffer .log-line:last-child { opacity: 1; color: var(--accent); }

.log-buffer .log-line:last-child::after {
  content: '\\u2588';
  animation: blink 1s step-end infinite;
  opacity: 0.6;
  margin-left: 2px;
  font-size: 10px;
}

.log-buffer.done { border-left-color: var(--success); }
.log-buffer.done .log-line:last-child { color: var(--success); }
.log-buffer.done .log-line:last-child::after { display: none; }

.log-buffer.errored { border-left-color: var(--error); }
.log-buffer.errored .log-line:last-child { color: var(--error); }
.log-buffer.errored .log-line:last-child::after { display: none; }

/* ── Install counter ─────────────────────── */
.install-counter {
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.04em;
  opacity: 0.6;
  margin-bottom: 16px;
  transition: opacity 0.3s, color 0.3s;
}
.install-counter.text-success { opacity: 1; }

.proof-card.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent), 0 2px 12px rgba(79, 193, 255, 0.08);
}

.proof-status {
  font-size: 12px;
  margin-top: 2px;
  transition: color 0.2s;
}

.log-cursor { animation: blink 1s step-end infinite; }

/* ── Passphrase modal ────────────────────── */

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: overlay-in 0.2s ease;
}

.modal-box {
  background: var(--card-bg);
  border: 1px solid rgba(var(--glow-color), 0.25);
  border-radius: 12px;
  padding: 32px;
  width: 400px;
  max-width: 90vw;
  box-shadow: 0 0 40px rgba(var(--glow-color), 0.08), 0 24px 48px rgba(0,0,0,0.4);
  animation: modal-in 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

.modal-box h3 { font-size: 16px; font-weight: 500; margin-bottom: 4px; }
.modal-box .modal-desc { font-size: 12px; opacity: 0.5; margin-bottom: 20px; }

.passphrase-input {
  width: 100%;
  padding: 10px 14px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 6px;
  color: var(--input-fg);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 14px;
  letter-spacing: 0.08em;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.passphrase-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(var(--glow-color), 0.15);
}

.modal-trust {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  opacity: 0.4;
  margin-top: 12px;
}

/* ── Top attention bar (browser-wait) ────── */

.top-bar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: linear-gradient(90deg, transparent 10%, var(--accent) 50%, transparent 90%);
  animation: top-pulse 1.5s ease-in-out infinite;
  z-index: 999;
}

.look-up-cue {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px;
  font-size: 12px;
  color: var(--accent);
  margin-top: 16px;
  border-radius: 6px;
  background: rgba(var(--glow-color), 0.06);
  border: 1px solid rgba(var(--glow-color), 0.15);
}

.look-up-arrow {
  font-size: 16px;
  animation: bounce-up 1.2s ease-in-out infinite;
  display: inline-block;
}

/* ── Misc ────────────────────────────────── */

.spacer { height: 16px; }
.spacer-lg { height: 32px; }
.muted { opacity: 0.5; font-size: 12px; }
.text-success { color: var(--success); }
.text-error { color: var(--error); }
`;

// ── JavaScript ────────────────────────────────────────────────

const JS = `
const vscode = acquireVsCodeApi();

// ── State ──────────────────────────────────

let currentStep = 0;
const STEPS = ['Welcome', 'Sign In', 'APIs', 'Credentials', 'Wire', 'Verify', 'Done'];

let loginEmail = '';
let registryAdapters = [];
let registrySkills = [];
let selectedAdapters = new Set();
let installedAdapters = [];
let tokenRequirements = [];
let selectedWireClients = new Set();
let proofResults = {};

const POPULAR = ['github', 'stripe', 'gmail', 'slack', 'jira', 'notion', 'linear'];

const WIRE_CLIENTS = [
  { id: 'dex-skill-claude-code', name: 'Claude Code', desc: 'Wire dex tools into Claude Code' },
  { id: 'dex-skill-cursor', name: 'Cursor', desc: 'Wire dex tools into Cursor IDE' },
  { id: 'dex-skill-codex', name: 'Codex', desc: 'Wire dex tools into OpenAI Codex' },
  { id: 'dex-agents-md', name: 'AGENTS.md', desc: 'Generate an AGENTS.md reference file' },
];

// ── Procedural SVG: stipple-dot concentric mark ──

function buildStippleSvg(size) {
  const rings = [
    { r: 6,  dotR: 2.2, count: 1,  opacity: 1 },
    { r: 14, dotR: 1.6, count: 10, opacity: 0.85 },
    { r: 22, dotR: 1.3, count: 16, opacity: 0.65 },
    { r: 30, dotR: 1.0, count: 22, opacity: 0.45 },
    { r: 38, dotR: 0.7, count: 28, opacity: 0.28 },
    { r: 46, dotR: 0.5, count: 36, opacity: 0.14 },
  ];
  let circles = '';
  for (const ring of rings) {
    if (ring.count === 1) {
      circles += '<circle cx="50" cy="50" r="' + ring.dotR + '" opacity="' + ring.opacity + '"/>';
      // Add a solid core
      circles += '<circle cx="50" cy="50" r="5" opacity="0.9"/>';
      continue;
    }
    for (let i = 0; i < ring.count; i++) {
      const angle = (Math.PI * 2 * i / ring.count) + (ring.r * 0.1); // slight offset per ring
      const jx = (Math.random() - 0.5) * 1.5; // subtle jitter
      const jy = (Math.random() - 0.5) * 1.5;
      const cx = (50 + Math.cos(angle) * ring.r + jx).toFixed(1);
      const cy = (50 + Math.sin(angle) * ring.r + jy).toFixed(1);
      circles += '<circle cx="' + cx + '" cy="' + cy + '" r="' + ring.dotR + '" opacity="' + ring.opacity + '"/>';
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="' + size + '" height="' + size + '" fill="currentColor">' + circles + '</svg>';
}

// ── Mouse-tracking glow ────────────────────

document.addEventListener('mousemove', (e) => {
  const cards = document.querySelectorAll('.glow-card');
  for (const card of cards) {
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%');
    card.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100) + '%');
  }
});

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
    html += '<div class="progress-dot ' + cls + '" data-label="' + STEPS[i] + '">' + icon + '</div>';
    if (i < STEPS.length - 1) {
      const lineCls = i < currentStep ? 'done' : (i === currentStep - 1 ? 'filling' : '');
      html += '<div class="progress-line ' + lineCls + '"></div>';
    }
    html += '</div>';
  }
  bar.innerHTML = html;
}

function renderStep() {
  renderProgressBar();
  const container = document.getElementById('stepContainer');
  container.innerHTML = '';

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
  const container = document.getElementById('stepContainer');
  container.classList.add('exiting');
  setTimeout(() => {
    container.classList.remove('exiting');
    currentStep = step;
    renderStep();
    container.classList.add('entering');
    container.addEventListener('animationend', () => {
      container.classList.remove('entering');
    }, { once: true });
  }, 180);
}

function next() { goTo(currentStep + 1); }

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Step 0: Welcome ────────────────────────

function renderWelcome(el) {
  el.innerHTML = \`
    <div class="hero">
      <div class="hero-logo">\${buildStippleSvg(120)}</div>
      <h1>modiqo dex</h1>
      <div class="tagline">Any API. Agent-ready. One command.</div>
      <button class="btn btn-primary" onclick="next()">
        Let's get started \\u2192
      </button>
    </div>
  \`;
}

// ── Step 1: Login ──────────────────────────

const GOOGLE_SVG = '<svg viewBox="0 0 24 24" width="36" height="36"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>';
const GITHUB_SVG = '<svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z"/></svg>';

function renderLogin(el) {
  if (loginEmail) {
    el.innerHTML = \`
      <h2>Signed in</h2>
      <div class="subtitle">You're authenticated with the dex registry.</div>
      <div class="login-status">
        <div style="font-size: 40px; color: var(--success); margin-bottom: 8px;">\\u2713</div>
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
    <div class="subtitle">Connect your account to access adapters and flows.</div>
    <div class="provider-cards">
      <div class="provider-card glow-card" onclick="doLogin('google')">
        <div class="icon">\${GOOGLE_SVG}</div>
        <div class="name">Google</div>
        <div class="hint">Sign in with Google</div>
      </div>
      <div class="provider-card glow-card" onclick="doLogin('github')">
        <div class="icon">\${GITHUB_SVG}</div>
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
  // Dim wizard + show top bar + look-up cue
  document.body.classList.add('dimmed');
  const topBar = document.createElement('div');
  topBar.className = 'top-bar';
  topBar.id = 'topBar';
  document.body.appendChild(topBar);
  vscode.postMessage({ type: 'login', provider });
}

function handleLoginStatus(msg) {
  if (msg.status === 'polling') {
    const el = document.getElementById('loginStatus');
    if (!el) return;
    el.innerHTML = \`
      <div class="login-status">
        <div class="spinner spinner-lg"></div>
        <p style="margin-top: 12px; opacity: 0.7;">Complete sign-in in your browser...</p>
        <div class="look-up-cue" style="margin-top: 16px; display: inline-flex;">
          <span class="look-up-arrow">\\u2191</span>
          <span>Check your browser window</span>
        </div>
      </div>
    \`;
  } else if (msg.status === 'success') {
    document.body.classList.remove('dimmed');
    const tb = document.getElementById('topBar');
    if (tb) tb.remove();
    loginEmail = msg.email;
    renderStep();
  } else if (msg.status === 'timeout') {
    document.body.classList.remove('dimmed');
    const tb = document.getElementById('topBar');
    if (tb) tb.remove();
    const el = document.getElementById('loginStatus');
    if (el) {
      el.innerHTML = '<div class="login-status"><p class="text-error">Login timed out. Please try again.</p></div>';
    }
  }
}

// ── Step 2: Adapter Selection ──────────────

function renderAdapters(el) {
  if (registryAdapters.length === 0) {
    el.innerHTML = \`
      <h2>Select APIs</h2>
      <div class="subtitle">Loading available adapters from registry...</div>
      <div style="text-align: center; padding: 40px;"><div class="spinner spinner-lg"></div></div>
    \`;
    return;
  }

  if (selectedAdapters.size === 0) {
    for (const a of registryAdapters) {
      if (POPULAR.includes(a.name)) selectedAdapters.add(a.name);
    }
  }

  let cards = '';
  for (const a of registryAdapters) {
    const sel = selectedAdapters.has(a.name) ? 'selected' : '';
    cards += \`
      <div class="adapter-card glow-card \${sel}" onclick="toggleAdapter('\${a.name}')">
        <div class="check">\${sel ? '\\u2713' : ''}</div>
        <div class="adapter-name">\${a.name}</div>
        <div class="adapter-desc">\${a.description || ''}</div>
      </div>
    \`;
  }

  el.innerHTML = \`
    <h2>Select APIs</h2>
    <div class="subtitle">Choose the APIs you want to connect. You can add more later.</div>
    <div class="card-grid">\${cards}</div>
    <div class="btn-row-right">
      <button class="btn btn-ghost" onclick="selectedAdapters.clear(); renderStep()">Clear all</button>
      <button class="btn btn-primary" onclick="installSelected()" id="installBtn"
        \${selectedAdapters.size === 0 ? 'disabled' : ''}>
        Install \${selectedAdapters.size} adapter\${selectedAdapters.size !== 1 ? 's' : ''} \\u2192
      </button>
    </div>
  \`;
}

function toggleAdapter(name) {
  if (selectedAdapters.has(name)) selectedAdapters.delete(name);
  else selectedAdapters.add(name);
  renderStep();
}

function installSelected() {
  const adapters = [...selectedAdapters];
  installedAdapters = adapters;

  // Replace the entire step content with the install progress view (in-place)
  const stepEl = document.getElementById('stepContainer');
  if (!stepEl) return;

  let cards = '';
  for (const a of adapters) {
    cards += \`
      <div class="proof-card" id="install-\${a}">
        <div class="proof-icon"><div class="dot-breathe"></div></div>
        <div class="proof-info" style="flex:1; min-width:0;">
          <div class="proof-name">\${a}</div>
          <div class="proof-status muted">Queued</div>
          <div class="log-buffer" id="log-\${a}"></div>
        </div>
      </div>
    \`;
  }

  stepEl.innerHTML = \`
    <h2>Installing APIs</h2>
    <div class="subtitle">Setting up \${adapters.length} adapter\${adapters.length !== 1 ? 's' : ''}. This may take a moment.</div>
    <div class="install-counter" id="installCounter">0 / \${adapters.length} complete</div>
    <div class="card-list" id="installList">\${cards}</div>
    <div id="installDoneRow"></div>
  \`;

  vscode.postMessage({ type: 'install-adapters', adapters });
}

function handleInstallProgress(msg) {
  const card = document.getElementById('install-' + msg.adapter);
  if (!card) return;

  const logEl = document.getElementById('log-' + msg.adapter);
  const statusEl = card.querySelector('.proof-status');

  if (msg.status === 'installing') {
    // Mark card as active — scroll into view
    card.classList.add('active');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    // Show breathing dot
    card.querySelector('.proof-icon').innerHTML = '<div class="dot-breathe"></div>';

    // Update status text
    if (statusEl) statusEl.textContent = msg.message;

    // Stream log lines into the log buffer
    if (logEl && msg.logs && msg.logs.length > 0) {
      logEl.style.display = 'block';
      logEl.innerHTML = msg.logs.map(l => '<div class="log-line">' + escapeHtml(l) + '</div>').join('')
        + '<div class="log-line log-cursor">\\u258A</div>';
    }
  } else if (msg.status === 'success') {
    card.classList.remove('active');
    card.className = 'proof-card success';
    card.querySelector('.proof-icon').innerHTML = '<span class="text-success" style="font-size:18px;">\\u2713</span>';
    if (statusEl) { statusEl.textContent = msg.message; statusEl.classList.remove('muted'); statusEl.classList.add('text-success'); }
    if (logEl) { logEl.style.display = 'none'; }
  } else if (msg.status === 'error') {
    card.classList.remove('active');
    card.className = 'proof-card error';
    card.querySelector('.proof-icon').innerHTML = '<span class="text-error" style="font-size:18px;">\\u2717</span>';
    if (statusEl) { statusEl.textContent = msg.message; statusEl.classList.remove('muted'); statusEl.classList.add('text-error'); }
    if (logEl) logEl.classList.add('errored');
  }

  // Update counter
  const allCards = document.querySelectorAll('[id^="install-"]');
  const doneCount = [...allCards].filter(c => c.classList.contains('success') || c.classList.contains('error')).length;
  const counter = document.getElementById('installCounter');
  if (counter) counter.textContent = doneCount + ' / ' + allCards.length + ' complete';

  const allDone = doneCount === allCards.length;
  if (allDone) {
    if (counter) counter.classList.add('text-success');
    const doneRow = document.getElementById('installDoneRow');
    if (doneRow) {
      doneRow.innerHTML = '<div class="btn-row-right" style="margin-top:24px;"><button class="btn btn-primary" onclick="next()">Continue \\u2192</button></div>';
    }
  }
}

// ── Step 3: Configure Auth ─────────────────

function renderAuth(el) {
  el.innerHTML = \`
    <h2>Configure Credentials</h2>
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
  for (const vt of vaultTokens) vaultMap[vt.name] = vt;

  if (tokenRequirements.length === 0) {
    el.innerHTML = \`
      <div style="text-align: center; padding: 24px;"><p class="muted">No tokens required for installed adapters.</p></div>
      <div class="btn-row-right"><button class="btn btn-primary" onclick="next()">Continue \\u2192</button></div>
    \`;
    return;
  }

  let html = '';

  // Vault pull card
  html += \`
    <div class="vault-card glow-card" id="vaultCard">
      <div class="vault-icon">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <rect x="3" y="9" width="14" height="9" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/>
          <path d="M6 9V6a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
          <circle cx="10" cy="13.5" r="1.5" fill="currentColor"/>
        </svg>
      </div>
      <div class="vault-body">
        <div class="vault-title">Pull from Vault</div>
        <div class="vault-desc muted">Restore encrypted tokens from the dex registry vault.</div>
      </div>
      <button class="btn btn-secondary" onclick="showPassphraseModal()" id="vaultPullBtn">Pull Vault</button>
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
          \${configured ? '<div style="margin-top:8px;"><button class="btn-link" onclick="toggleOAuthReconfigure(\\'' + req.env_var + '\\')">Reconfigure OAuth (token may be expired)</button></div>' : ''}
          <div id="oauth-body-\${req.env_var}" style="\${oauthExpanded ? '' : 'display:none;'}">
            <div class="section-title" style="margin-top:16px;">Select OAuth Scopes</div>
            <div class="scope-grid" id="scopes-\${req.env_var}">
              <label class="scope-chip glow-card selected" onclick="toggleScope(this)">
                <input type="checkbox" value="gmail.readonly" checked>
                <div class="scope-check">\\u2713</div>
                <div><div class="scope-label">Gmail Read</div><div class="scope-desc">Read messages & labels</div></div>
              </label>
              <label class="scope-chip glow-card selected" onclick="toggleScope(this)">
                <input type="checkbox" value="gmail.compose" checked>
                <div class="scope-check">\\u2713</div>
                <div><div class="scope-label">Gmail Compose</div><div class="scope-desc">Draft & send emails</div></div>
              </label>
              <label class="scope-chip glow-card selected" onclick="toggleScope(this)">
                <input type="checkbox" value="gmail.send" checked>
                <div class="scope-check">\\u2713</div>
                <div><div class="scope-label">Gmail Send</div><div class="scope-desc">Send on your behalf</div></div>
              </label>
              <label class="scope-chip glow-card selected" onclick="toggleScope(this)">
                <input type="checkbox" value="calendar" checked>
                <div class="scope-check">\\u2713</div>
                <div><div class="scope-label">Calendar</div><div class="scope-desc">Read & write events</div></div>
              </label>
              <label class="scope-chip glow-card" onclick="toggleScope(this)">
                <input type="checkbox" value="drive.readonly">
                <div class="scope-check">\\u2713</div>
                <div><div class="scope-label">Drive</div><div class="scope-desc">Read files from Drive</div></div>
              </label>
            </div>
            <button class="btn btn-primary" onclick="startOAuth('\${req.env_var}')">Configure Google OAuth \\u2192</button>
            <div id="oauth-status-\${req.env_var}"></div>
          </div>
        </div>
      \`;
    } else {
      const urlHtml = req.url ? '<a href="' + req.url + '" style="color:var(--accent);font-size:11px;text-decoration:none;">Get token \\u2197</a>' : '';
      html += \`
        <div class="token-card \${cls}" id="token-\${req.env_var}">
          <div class="token-header">
            <span class="token-name">\${req.env_var}</span>
            <span>\${configured ? '<span class="status-badge success">\\u2713 Configured</span>' : urlHtml}</span>
          </div>
          <div class="token-adapters">Used by: \${req.adapters.join(', ')}</div>
          \${fromVault && !req.configured ? '<div class="muted" style="margin-bottom:8px;">\\u2713 Found in vault</div>' : ''}
          \${configured ? \`
            <div style="margin-top:6px;"><button class="btn-link" onclick="toggleTokenReconfigure('\${req.env_var}')">Reconfigure token</button></div>
            <div id="token-body-\${req.env_var}" style="display:none; margin-top:8px;">
              <div class="token-input-row">
                <input type="password" class="token-input" id="input-\${req.env_var}" placeholder="Paste new \${req.env_var} token">
                <button class="btn btn-primary" onclick="setToken('\${req.env_var}')">Set</button>
              </div>
            </div>
          \` : \`
            <div class="token-input-row">
              <input type="password" class="token-input" id="input-\${req.env_var}" placeholder="Paste your \${req.env_var} token here">
              <button class="btn btn-primary" onclick="setToken('\${req.env_var}')">Set</button>
            </div>
          \`}
        </div>
      \`;
    }
  }
  html += '</div>';
  html += '<div class="btn-row-right"><button class="btn btn-ghost" onclick="next()">Skip remaining</button><button class="btn btn-primary" onclick="next()">Continue \\u2192</button></div>';
  el.innerHTML = html;
}

// ── Passphrase modal (in-webview) ──────────

function showPassphraseModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'passphraseModal';
  overlay.innerHTML = \`
    <div class="modal-box">
      <h3>\\u{1F512} Vault Passphrase</h3>
      <p class="modal-desc">Your passphrase decrypts the token vault locally.</p>
      <input type="password" class="passphrase-input" id="passphraseInput" placeholder="Enter passphrase..." autocomplete="off"/>
      <div class="modal-trust">\\u{1F513} Encrypted locally &middot; Never transmitted</div>
      <div class="btn-row" style="margin-top:20px; justify-content:flex-end;">
        <button class="btn btn-secondary" onclick="dismissPassphrase()">Cancel</button>
        <button class="btn btn-primary" onclick="submitPassphrase()">Unlock \\u2192</button>
      </div>
    </div>
  \`;
  document.body.appendChild(overlay);

  requestAnimationFrame(() => requestAnimationFrame(() => {
    const input = document.getElementById('passphraseInput');
    if (input) input.focus();
  }));

  overlay.addEventListener('click', (e) => { if (e.target === overlay) dismissPassphrase(); });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitPassphrase();
    if (e.key === 'Escape') dismissPassphrase();
  });
}

function dismissPassphrase() {
  const m = document.getElementById('passphraseModal');
  if (m) m.remove();
}

function submitPassphrase() {
  const input = document.getElementById('passphraseInput');
  const passphrase = input ? input.value : '';
  if (!passphrase) return;
  dismissPassphrase();
  const statusEl = document.getElementById('vaultPullStatus');
  if (statusEl) {
    statusEl.innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;"><div class="spinner"></div><span class="muted">Pulling vault...</span></div>';
  }
  vscode.postMessage({ type: 'vault-pull-with-passphrase', passphrase });
}

function handleVaultPullStatus(msg) {
  const statusEl = document.getElementById('vaultPullStatus');
  const vaultCard = document.getElementById('vaultCard');
  if (!statusEl) return;

  if (msg.success) {
    // Collapse the vault card and show success banner
    if (vaultCard) {
      vaultCard.classList.add('vault-success');
      const btn = document.getElementById('vaultPullBtn');
      if (btn) { btn.textContent = 'Pulled'; btn.disabled = true; btn.classList.add('btn-success-done'); }
    }
    statusEl.innerHTML = \`
      <div class="vault-status-banner success">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" style="flex-shrink:0;">
          <circle cx="9" cy="9" r="8" stroke="var(--success)" stroke-width="1.5" fill="none"/>
          <path d="M5.5 9.5l2 2 5-5" stroke="var(--success)" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <div>
          <div class="vault-status-title">\${escapeHtml(msg.message)}</div>
          <div class="vault-status-hint muted">Tokens below have been updated from the vault.</div>
        </div>
      </div>
    \`;
  } else {
    statusEl.innerHTML = \`
      <div class="vault-status-banner error">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" style="flex-shrink:0;">
          <circle cx="9" cy="9" r="8" stroke="var(--error)" stroke-width="1.5" fill="none"/>
          <path d="M6 6l6 6M12 6l-6 6" stroke="var(--error)" stroke-width="1.5" fill="none" stroke-linecap="round"/>
        </svg>
        <div>
          <div class="vault-status-title">\${escapeHtml(msg.message)}</div>
          <div class="vault-status-hint muted">Check your passphrase and try again.</div>
        </div>
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
    const badge = card.querySelector('.status-badge');
    if (badge) { badge.className = 'status-badge success'; badge.innerHTML = '\\u2713 Configured'; }
    else { card.querySelector('.token-header').innerHTML += '<span class="status-badge success">\\u2713 Configured</span>'; }
    const inputRow = card.querySelector('.token-input-row');
    if (inputRow) inputRow.style.display = 'none';
  }
}

function toggleOAuthReconfigure(envVar) {
  const body = document.getElementById('oauth-body-' + envVar);
  if (body) body.style.display = body.style.display === 'none' ? '' : 'none';
}

function toggleTokenReconfigure(envVar) {
  const body = document.getElementById('token-body-' + envVar);
  if (body) body.style.display = body.style.display === 'none' ? '' : 'none';
}

function toggleScope(chip) {
  const cb = chip.querySelector('input[type="checkbox"]');
  cb.checked = !cb.checked;
  chip.classList.toggle('selected', cb.checked);
}

function startOAuth(envVar) {
  const scopeContainer = document.getElementById('scopes-' + envVar);
  const scopes = [...scopeContainer.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value);
  if (scopes.length === 0) { alert('Select at least one scope'); return; }
  vscode.postMessage({ type: 'oauth-setup-google', scopes });
}

function handleOAuthStatus(msg) {
  const els = document.querySelectorAll('[id^="oauth-status-"]');
  for (const el of els) {
    if (msg.status === 'starting' || msg.status === 'in-progress') {
      el.innerHTML = '<div style="margin-top:12px;display:flex;align-items:center;gap:8px;"><div class="spinner"></div><span class="muted">' + msg.message + '</span></div>';
    } else if (msg.status === 'success') {
      el.innerHTML = '<div style="margin-top:12px;" class="text-success">\\u2713 ' + msg.message + '</div>';
      const card = el.closest('.token-card');
      if (card) card.classList.add('configured');
    } else if (msg.status === 'error') {
      el.innerHTML = '<div style="margin-top:12px;" class="text-error">\\u2717 ' + msg.message + '</div>';
    }
  }
}

// ── Step 4: Wire AI Tools ──────────────────

function renderWire(el) {
  if (selectedWireClients.size === 0) selectedWireClients.add(WIRE_CLIENTS[0].id);

  let cards = '';
  for (const c of WIRE_CLIENTS) {
    const sel = selectedWireClients.has(c.id) ? 'selected' : '';
    cards += \`
      <div class="wire-card glow-card \${sel}" onclick="toggleWire('\${c.id}')">
        <div class="wire-icon">\\u{2B21}</div>
        <div class="wire-info">
          <div class="wire-name">\${c.name}</div>
          <div class="wire-desc">\${c.desc}</div>
        </div>
        <div class="wire-check">\${sel ? '\\u2713' : ''}</div>
      </div>
    \`;
  }

  const stdioServers = [
    { name: 'Playwright (headed)', desc: 'Browser automation \\u2014 visible Chrome window' },
    { name: 'Playwright (headless)', desc: 'Browser automation \\u2014 invisible, for CI/scripts' },
    { name: 'Chrome DevTools (headed)', desc: 'Chrome DevTools protocol \\u2014 visible' },
    { name: 'Chrome DevTools (headless)', desc: 'Chrome DevTools protocol \\u2014 headless' },
    { name: 'Filesystem', desc: 'Read/write files in /tmp sandbox' },
  ];
  let stdioHtml = stdioServers.map(s => \`
    <div style="display:flex; align-items:center; gap:10px; padding:5px 0;">
      <span class="text-success" style="font-size:12px; flex-shrink:0;">\\u2713</span>
      <div>
        <div style="font-size:12px; font-weight:500;">\${s.name}</div>
        <div class="muted" style="font-size:11px;">\${s.desc}</div>
      </div>
    </div>
  \`).join('');

  el.innerHTML = \`
    <h2>Wire AI Tools</h2>
    <div class="subtitle">Install dex skills into your preferred AI coding tools.</div>
    <div class="card-list">\${cards}</div>
    <div style="margin-top: 24px;">
      <div class="section-title">Included: Standard MCP Bundle</div>
      <div class="card" style="border-image: linear-gradient(135deg, rgba(var(--glow-color),0.3), var(--card-border), rgba(var(--glow-color),0.3)) 1;">
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:10px;">
          <div style="font-size:18px; opacity:0.7;">\\u{2B21}</div>
          <div>
            <div style="font-weight:500;">Stdio MCP Servers</div>
            <div class="muted" style="font-size:11px;">Auto-configured \\u2014 browser automation, DevTools, and filesystem access.</div>
          </div>
        </div>
        <div style="border-top:1px solid var(--card-border); padding-top:8px;">\${stdioHtml}</div>
      </div>
    </div>
    <div class="btn-row-right" id="wireActions">
      <button class="btn btn-ghost" onclick="next()">Skip</button>
      <button class="btn btn-primary" onclick="wireSelected()" \${selectedWireClients.size === 0 ? 'disabled' : ''}>
        Wire \${selectedWireClients.size} tool\${selectedWireClients.size !== 1 ? 's' : ''} \\u2192
      </button>
    </div>
    <div id="wireStatus"></div>
  \`;
}

function toggleWire(id) {
  if (selectedWireClients.has(id)) selectedWireClients.delete(id);
  else selectedWireClients.add(id);
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
        <div class="proof-icon"><div class="dot-breathe"></div></div>
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
    document.getElementById('wireStatus').innerHTML += '<div class="btn-row-right"><button class="btn btn-primary" onclick="next()">Continue \\u2192</button></div>';
  }
}

// ── Step 5: Proof of Life ──────────────────

function renderProof(el) {
  const adapters = installedAdapters.length > 0 ? installedAdapters : [];
  if (adapters.length === 0) {
    el.innerHTML = '<h2>Verification</h2><div class="subtitle">No adapters to verify.</div><div class="btn-row-right"><button class="btn btn-primary" onclick="next()">Finish Setup \\u2192</button></div>';
    return;
  }

  let cards = '';
  for (const a of adapters) {
    cards += \`
      <div class="verify-card" id="proof-\${a}">
        <div class="verify-header">
          <div class="verify-status-dot"><div class="dot-breathe"></div></div>
          <div class="verify-adapter-name">\${a}</div>
          <div class="verify-badge" id="badge-\${a}">Running</div>
        </div>
        <div class="verify-body" id="body-\${a}">
          <div class="verify-running muted">Executing proof-of-life check...</div>
        </div>
      </div>
    \`;
  }

  el.innerHTML = \`
    <h2>Verification</h2>
    <div class="subtitle">Running proof-of-life checks on your configured adapters.</div>
    <div class="verify-counter" id="verifyCounter">0 / \${adapters.length} verified</div>
    <div class="verify-list">\${cards}</div>
    <div id="proofActions"></div>
  \`;
  vscode.postMessage({ type: 'run-proof-of-life', adapters });
}

function handleProofResult(msg) {
  const card = document.getElementById('proof-' + msg.adapter);
  if (!card) return;
  proofResults[msg.adapter] = msg;

  const body = document.getElementById('body-' + msg.adapter);
  const badge = document.getElementById('badge-' + msg.adapter);
  const dot = card.querySelector('.verify-status-dot');

  if (msg.status === 'success') {
    card.classList.add('success');

    // Status dot → green check
    if (dot) dot.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="8" fill="var(--success)" opacity="0.15"/><path d="M5.5 9.5l2 2 5-5" stroke="var(--success)" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    // Badge
    if (badge) { badge.className = 'verify-badge success'; badge.textContent = 'Passed'; }

    // Parse output into structured display
    const lines = (msg.output || '').split('\\n').filter(l => l.trim());
    if (body && lines.length > 0) {
      // First line is the summary/header, rest are detail items
      const header = lines[0];
      const details = lines.slice(1);
      let html = '<div class="verify-result-header">' + escapeHtml(header) + '</div>';
      if (details.length > 0) {
        html += '<div class="verify-detail-list">';
        for (const d of details) {
          html += '<div class="verify-detail-item">' + escapeHtml(d) + '</div>';
        }
        html += '</div>';
      }
      body.innerHTML = html;
    } else if (body) {
      body.innerHTML = '<div class="verify-result-header">Verified</div>';
    }
  } else if (msg.status === 'error') {
    card.classList.add('error');

    // Status dot → red x
    if (dot) dot.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="8" fill="var(--error)" opacity="0.15"/><path d="M6.5 6.5l5 5M11.5 6.5l-5 5" stroke="var(--error)" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>';

    // Badge
    if (badge) { badge.className = 'verify-badge error'; badge.textContent = 'Failed'; }

    // Error display
    if (body) {
      const errText = escapeHtml(msg.error || 'Check failed');
      body.innerHTML = \`
        <div class="verify-error-msg">\${errText}</div>
        <div class="verify-error-hint">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="flex-shrink:0;opacity:0.5;">
            <path d="M6 1v4M6 7v4M1 6h4M7 6h4" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
          </svg>
          <span>Run <code>dex powerpack credentials</code> to fix</span>
        </div>
      \`;
    }
  }

  // Update counter
  const allCards = document.querySelectorAll('[id^="proof-"]');
  const doneCount = [...allCards].filter(c => c.classList.contains('success') || c.classList.contains('error')).length;
  const counter = document.getElementById('verifyCounter');
  if (counter) counter.textContent = doneCount + ' / ' + allCards.length + ' verified';

  const allDone = doneCount === allCards.length;
  if (allDone) {
    const successCount = [...allCards].filter(c => c.classList.contains('success')).length;
    if (counter) {
      counter.textContent = successCount + ' / ' + allCards.length + ' passed';
      counter.classList.add(successCount === allCards.length ? 'text-success' : 'text-warning');
    }
    document.getElementById('proofActions').innerHTML = '<div class="btn-row-right" style="margin-top:24px;"><button class="btn btn-primary" onclick="next()">Complete Setup \\u2192</button></div>';
  }
}

// ── Step 6: Complete ───────────────────────

function renderComplete(el) {
  const adapterCount = installedAdapters.length;
  const tokenCount = tokenRequirements.filter(t => t.configured).length;
  const wireCount = selectedWireClients.size;

  el.innerHTML = \`
    <div class="complete-hero">
      <div class="complete-logo">\${buildStippleSvg(48)}</div>
      <h1>You're all set</h1>
      <div class="subtitle">modiqo dex is configured and ready to go.</div>
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
      <button class="btn btn-primary" onclick="finishSetup()">Open dex \\u2192</button>
    </div>
  \`;
}

function finishSetup() {
  vscode.postMessage({ type: 'complete-setup' });
}

// ── Init ───────────────────────────────────

renderStep();
`;
