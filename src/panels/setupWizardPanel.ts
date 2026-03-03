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

  // Resume at the first incomplete step based on actual system state
  client.wizardCheckpoint().then(step => {
    if (step > 0) {
      panel.webview.postMessage({ type: "resume-at-step", step });
    }
  });

  panel.webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
      case "login": {
        handleLogin(panel, client, msg.provider);
        break;
      }
      case "waitlist": {
        const result = await client.waitlist(msg.email);
        panel.webview.postMessage({ type: "waitlist-status", ...result });
        break;
      }
      case "join-invite": {
        const result = await client.joinInvite(msg.code);
        panel.webview.postMessage({ type: "join-status", ...result });
        if (result.success) {
          // Reload registry data now that invite is claimed
          loadRegistryData(panel, client);
        }
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
            vaultTokens: freshVault,
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
      case "open-sidebar-view": {
        vscode.commands.executeCommand(`${msg.view}.focus`).then(
          () => {},
          () => {},
        );
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
  const alreadyPulled = new Set<string>();

  // Mark all as pending immediately
  for (const id of adapterIds) {
    panel.webview.postMessage({
      type: "install-progress",
      adapter: id,
      status: "installing",
      message: "Connecting to registry...",
      logs: [],
    });
  }

  await Promise.all(adapterIds.map(async (id) => {
    const child = client.installAdapterStream(id);
    const logLines: string[] = [];

    const pushLog = (raw: string) => {
      const lines = raw.split("\n").map((l: string) => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (/^[─┌┐└┘├┤┬┴┼│]+$/.test(line)) { continue; }
        logLines.push(line);
      }
      const recent = logLines.slice(-3);
      panel.webview.postMessage({
        type: "install-progress",
        adapter: id,
        status: "installing",
        message: recent[recent.length - 1] || "Installing...",
        logs: recent,
      });
    };

    child.stdout?.on("data", (data: Buffer) => { pushLog(data.toString()); });
    child.stderr?.on("data", (data: Buffer) => { pushLog(data.toString()); });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", resolve);
      child.on("error", () => resolve(1));
    });

    if (exitCode === 0) {
      const recent = logLines.slice(-3);
      panel.webview.postMessage({
        type: "install-progress",
        adapter: id,
        status: "installing",
        message: "Pulling associated flows...",
        logs: recent,
      });

      const skillCount = await client.pullAssociatedSkills(id, alreadyPulled);
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
  }));
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
  // Dedup: adapters sharing the same proof flow (e.g. polymarket-data & polymarket-gamma)
  const seenFlows = new Map<string, Promise<ProofResult>>();

  // Mark all as running immediately, then fire in parallel
  for (const id of adapterIds) {
    panel.webview.postMessage({ type: "proof-result", adapter: id, status: "running" });
  }

  await Promise.all(adapterIds.map(async (id) => {
    const flowKey = client.proofFlowKey(id);
    let resultPromise: Promise<ProofResult>;
    if (flowKey && seenFlows.has(flowKey)) {
      resultPromise = seenFlows.get(flowKey)!.then(r => ({ ...r, adapter: id }));
    } else {
      resultPromise = client.runProofOfLife(id);
      if (flowKey) { seenFlows.set(flowKey, resultPromise); }
    }
    const result = await resultPromise;
    panel.webview.postMessage({
      type: "proof-result",
      adapter: id,
      status: result.success ? "success" : "error",
      output: result.output,
      error: result.error,
    });
  }));
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
    <div id="ttaTimer" style="position:fixed; top:12px; right:20px; font-size:0.92em; font-weight:700; color:var(--fg); font-variant-numeric:tabular-nums; letter-spacing:0.01em;"></div>
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

.step-container { min-height: 200px; padding-bottom: 24px; }
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

/* ── Catalog: Selection strip ────────────── */
.selection-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 10px 0 16px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 24px;
}
.selection-strip:empty { display: none; }
.selection-strip-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.4;
  margin-right: 4px;
}
.selection-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px 4px 12px;
  border-radius: 16px;
  background: rgba(var(--glow-color), 0.08);
  border: 1px solid rgba(var(--glow-color), 0.18);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  animation: step-enter-forward 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}
.selection-tag:hover { background: rgba(var(--glow-color), 0.14); }
.selection-tag .tag-x {
  font-size: 10px;
  opacity: 0.5;
  line-height: 1;
  transition: opacity 0.15s;
}
.selection-tag:hover .tag-x { opacity: 1; }

/* ── Catalog: Category sections ──────────── */
.catalog-section {
  margin-bottom: 28px;
}
.catalog-section-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  opacity: 0.35;
  margin-bottom: 12px;
  padding-left: 2px;
}
.catalog-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 10px;
}

/* ── Catalog: Adapter cards ──────────────── */
.catalog-card {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 16px 18px;
  border-radius: 10px;
  background: var(--card-bg);
  border: 1.5px solid var(--card-border);
  cursor: pointer;
  transition: all 0.18s ease;
  position: relative;
}
.catalog-card:hover {
  border-color: rgba(var(--glow-color), 0.25);
  box-shadow: 0 2px 12px rgba(0,0,0,0.06);
}
.catalog-card.selected {
  border-color: var(--accent);
  background: rgba(var(--glow-color), 0.03);
}
.catalog-card.selected::after {
  content: '';
  position: absolute;
  inset: -1.5px;
  border-radius: 11px;
  border: 1.5px solid var(--accent);
  pointer-events: none;
  animation: success-ripple 0.35s ease-out;
}

.catalog-icon {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  transition: background 0.18s, opacity 0.18s;
}
body.vscode-dark .catalog-icon { background: rgba(255,255,255,0.06); }
body.vscode-light .catalog-icon { background: rgba(0,0,0,0.04); }
.catalog-card.selected .catalog-icon {
  background: rgba(var(--glow-color), 0.12);
}

.catalog-icon svg { width: 18px; height: 18px; opacity: 0.6; }
.catalog-card.selected .catalog-icon svg { opacity: 1; color: var(--accent); }

.catalog-body { flex: 1; min-width: 0; }
.catalog-name {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 3px;
  letter-spacing: -0.01em;
}
.catalog-desc {
  font-size: 11px;
  opacity: 0.45;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.catalog-card.selected .catalog-desc { opacity: 0.6; }

.catalog-toggle {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  border: 1.5px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
  margin-top: 2px;
}
.catalog-card.selected .catalog-toggle {
  border-color: var(--accent);
  background: var(--accent);
  animation: check-pop 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}
.catalog-toggle-check { display: none; }
.catalog-card.selected .catalog-toggle-check { display: block; }

/* ── Catalog: Floating install bar ───────── */
.install-bar {
  position: sticky;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 16px 24px;
  background: var(--bg);
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  z-index: 10;
  animation: step-enter-forward 0.25s ease;
}
body.vscode-dark .install-bar { background: rgba(30, 30, 30, 0.92); backdrop-filter: blur(8px); }
body.vscode-light .install-bar { background: rgba(255, 255, 255, 0.92); backdrop-filter: blur(8px); }
.install-bar .install-count {
  font-size: 13px;
  opacity: 0.6;
  flex: 1;
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

/* ── Journey sections (waitlist / invite / sign-in) ── */

.journey-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 8px;
}

.journey-section {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 10px;
  overflow: hidden;
  transition: border-color 0.2s;
}

.journey-section:hover {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--card-border));
}

.journey-header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 20px;
  cursor: pointer;
  user-select: none;
}

.journey-header:hover { opacity: 0.9; }

.journey-step-num {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  color: var(--accent);
  font-weight: 700;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.journey-step-info { flex: 1; }

.journey-step-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 2px;
}

.journey-step-hint {
  font-size: 12px;
  opacity: 0.5;
}

.journey-chevron {
  font-size: 10px;
  opacity: 0.4;
  transition: transform 0.2s;
}

.journey-body {
  padding: 0 20px 20px;
  animation: journey-expand 0.2s ease;
}

.journey-body.collapsed {
  display: none;
}

@keyframes journey-expand {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: translateY(0); }
}

.journey-input-row {
  display: flex;
  gap: 10px;
  align-items: stretch;
}

.journey-input {
  flex: 1;
  background: var(--vscode-input-background, rgba(255,255,255,0.06));
  color: var(--fg);
  border: 1px solid var(--vscode-input-border, var(--card-border));
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
  font-family: var(--vscode-font-family);
  outline: none;
  transition: border-color 0.15s;
}

.journey-input:focus {
  border-color: var(--accent);
}

.journey-input.input-error {
  border-color: var(--error);
}

.journey-input::placeholder {
  opacity: 0.35;
}

.journey-field-hint {
  font-size: 11px;
  opacity: 0.4;
  margin-top: 8px;
  padding-left: 2px;
}

.journey-success {
  color: var(--success);
  font-size: 13px;
  margin-top: 10px;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--success) 8%, transparent);
  border-radius: 6px;
}

.journey-error {
  color: var(--error);
  font-size: 13px;
  margin-top: 10px;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--error) 8%, transparent);
  border-radius: 6px;
}

/* ── Done page accordions ────────────────── */

.done-accordions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 24px;
}

.done-section {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 10px;
  overflow: hidden;
  transition: border-color 0.2s;
}

.done-section:hover {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--card-border));
}

.done-header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 20px;
  cursor: pointer;
  user-select: none;
}

.done-header:hover { opacity: 0.9; }

.done-header-icon {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  border-radius: 8px;
}

.done-header-info { flex: 1; }

.done-header-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 2px;
}

.done-header-hint {
  font-size: 12px;
  opacity: 0.5;
}

.done-chevron {
  font-size: 10px;
  opacity: 0.4;
  transition: transform 0.2s;
}

.done-body {
  padding: 0 20px 20px;
  animation: journey-expand 0.2s ease;
}

.done-body.collapsed {
  display: none;
}

.done-aha {
  font-size: 13px;
  line-height: 1.65;
}

.done-aha p { margin: 0 0 10px; }

.done-aha-lead {
  font-weight: 600;
  font-size: 14px;
  opacity: 0.85;
}

.done-aha-kicker {
  font-size: 13px;
  opacity: 0.7;
  font-style: italic;
  margin-top: 6px;
}

.done-link {
  color: var(--accent);
  text-decoration: none;
  font-weight: 500;
  border-bottom: 1px dotted color-mix(in srgb, var(--accent) 40%, transparent);
  transition: opacity 0.15s;
}

.done-link:hover { opacity: 0.8; }

.done-cta-row {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--card-border);
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  opacity: 0.8;
}

.done-link-btn {
  color: var(--accent);
  text-decoration: none;
  font-weight: 600;
  font-size: 13px;
  transition: opacity 0.15s;
}

.done-link-btn:hover { opacity: 0.7; text-decoration: underline; }

.done-more-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.done-more-card {
  background: color-mix(in srgb, var(--accent) 5%, transparent);
  border: 1px solid var(--card-border);
  border-radius: 8px;
  padding: 16px;
  cursor: pointer;
  transition: all 0.15s;
  text-align: center;
}

.done-more-card:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--accent) 40%, var(--card-border));
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}

.done-more-icon {
  margin-bottom: 8px;
  display: flex;
  justify-content: center;
}

.done-more-label {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 3px;
}

.done-more-desc {
  font-size: 11px;
  opacity: 0.5;
  line-height: 1.4;
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

.wire-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 24px;
}

.wire-card {
  background: var(--card-bg);
  border: 1.5px solid var(--card-border);
  border-radius: 12px;
  padding: 20px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  flex-direction: column;
  gap: 14px;
  position: relative;
}
.wire-card:hover {
  border-color: rgba(var(--glow-color), 0.25);
  box-shadow: 0 4px 16px rgba(0,0,0,0.06);
  transform: translateY(-1px);
}
.wire-card.selected {
  border-color: var(--accent);
  background: rgba(var(--glow-color), 0.03);
}
.wire-card.selected::after {
  content: '';
  position: absolute;
  inset: -1.5px;
  border-radius: 13px;
  border: 1.5px solid var(--accent);
  pointer-events: none;
}

.wire-brand {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
body.vscode-dark .wire-brand { background: rgba(255,255,255,0.07); }
body.vscode-light .wire-brand { background: rgba(0,0,0,0.05); }
.wire-card.selected .wire-brand { background: rgba(var(--glow-color), 0.12); }
.wire-brand svg { width: 24px; height: 24px; opacity: 0.7; }
.wire-card.selected .wire-brand svg { opacity: 1; }

.wire-info { flex: 1; }
.wire-name { font-weight: 600; font-size: 14px; margin-bottom: 3px; }
.wire-desc { font-size: 11px; opacity: 0.45; line-height: 1.4; }
.wire-card.selected .wire-desc { opacity: 0.6; }

.wire-toggle {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  border: 1.5px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}
.wire-card.selected .wire-toggle {
  border-color: var(--accent);
  background: var(--accent);
  animation: check-pop 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}
.wire-toggle-check { display: none; }
.wire-card.selected .wire-toggle-check { display: block; }

/* ── MCP bundle ──────────────────────────── */
.mcp-bundle {
  border-radius: 10px;
  border: 1px solid var(--card-border);
  overflow: hidden;
  margin-bottom: 24px;
}
.mcp-bundle-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  background: rgba(var(--glow-color), 0.03);
  border-bottom: 1px solid var(--card-border);
}
body.vscode-dark .mcp-bundle-header { background: rgba(255,255,255,0.02); }
.mcp-bundle-title { font-weight: 600; font-size: 13px; }
.mcp-bundle-sub { font-size: 11px; opacity: 0.5; }
.mcp-bundle-label {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 2px 7px;
  border-radius: 8px;
  background: rgba(var(--glow-success), 0.12);
  color: var(--success);
  margin-left: auto;
}
.mcp-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 18px;
}
.mcp-item:last-child { padding-bottom: 12px; }
.mcp-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--success);
  flex-shrink: 0;
  opacity: 0.6;
}
.mcp-item-name { font-size: 12px; font-weight: 500; }
.mcp-item-desc { font-size: 11px; opacity: 0.4; margin-left: 4px; }

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
  align-items: center;
  gap: 16px;
  padding: 16px 20px;
  border-radius: 10px;
  margin-bottom: 16px;
  animation: step-enter-forward 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}
.vault-status-banner.success { background: rgba(var(--glow-success), 0.08); border: 1px solid rgba(var(--glow-success), 0.2); }
.vault-status-banner.error { background: rgba(241, 76, 76, 0.08); border: 1px solid rgba(241, 76, 76, 0.2); }
.vault-status-title { font-weight: 500; font-size: 13px; }
.vault-status-hint { font-size: 12px; margin-top: 2px; opacity: 0.7; }

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

/* ── Proof output modal ──────────────────── */
.proof-modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 999;
  display: flex; align-items: center; justify-content: center;
}
.proof-modal {
  background: var(--bg); border: 1px solid var(--border); border-radius: 12px;
  width: min(640px, 92vw); max-height: 75vh; display: flex; flex-direction: column;
  box-shadow: 0 24px 64px rgba(0,0,0,0.4);
}
.proof-modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px 12px; border-bottom: 1px solid var(--border);
}
.proof-modal-title { font-weight: 600; font-size: 0.95em; }
.proof-modal-close {
  background: none; border: none; color: var(--fg-dim); cursor: pointer;
  font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 4px;
}
.proof-modal-close:hover { color: var(--fg); background: var(--border); }
.proof-modal-body {
  overflow-y: auto; padding: 16px 20px; flex: 1;
  font-family: var(--mono); font-size: 0.8em; line-height: 1.6; white-space: pre-wrap;
  color: var(--fg);
}
.proof-modal-footer {
  padding: 10px 20px; border-top: 1px solid var(--border);
  font-size: 0.72em; color: var(--fg-dim);
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

.hero-wordmark {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  margin-bottom: 4px;
}
.hero-wordmark svg { height: 32px; }

.hero .tagline {
  font-size: 15px;
  opacity: 0.45;
  margin: 8px 0 36px;
}

/* ── Complete screen ─────────────────────── */

.complete-hero {
  text-align: center;
  padding: 24px 0 0;
}

.complete-logo {
  display: inline-block;
  margin-bottom: 10px;
  animation: hue-drift 4s ease-in-out infinite;
}

.complete-logo svg { width: 40px; height: 40px; color: var(--success); }

.complete-hero h1 {
  color: var(--success);
  font-weight: 300;
  letter-spacing: -0.5px;
  margin-bottom: 4px;
}

.complete-hero .subtitle { margin-bottom: 0; }

/* Summary stats row */
.summary-row {
  display: flex;
  justify-content: center;
  gap: 32px;
  padding: 20px 0;
  margin: 0 0 24px;
  border-bottom: 1px solid var(--border);
}
.summary-stat {
  text-align: center;
  opacity: 0;
  animation: stagger-in 0.4s ease forwards;
}
.summary-stat:nth-child(1) { animation-delay: 0.1s; }
.summary-stat:nth-child(2) { animation-delay: 0.2s; }
.summary-stat:nth-child(3) { animation-delay: 0.3s; }
.summary-stat-num {
  font-size: 22px;
  font-weight: 300;
  color: var(--accent);
  line-height: 1;
}
.summary-stat-label { font-size: 10px; opacity: 0.45; margin-top: 4px; letter-spacing: 0.04em; }

/* Try it section */
.try-section-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  opacity: 0.35;
  margin-bottom: 14px;
}

.try-card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 10px;
  padding: 16px 18px;
  margin-bottom: 10px;
  display: flex;
  align-items: flex-start;
  gap: 14px;
  opacity: 0;
  animation: stagger-in 0.4s ease forwards;
}
.try-card:nth-child(2) { animation-delay: 0.15s; }
.try-card:nth-child(3) { animation-delay: 0.25s; }
.try-card:nth-child(4) { animation-delay: 0.35s; }

.try-icon {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
body.vscode-dark .try-icon { background: rgba(255,255,255,0.06); }
body.vscode-light .try-icon { background: rgba(0,0,0,0.04); }
.try-icon svg { width: 18px; height: 18px; opacity: 0.6; }

.try-body { flex: 1; min-width: 0; }
.try-tool {
  font-weight: 600;
  font-size: 12px;
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.try-tool-badge {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.05em;
  padding: 1px 6px;
  border-radius: 6px;
  opacity: 0.7;
}
body.vscode-dark .try-tool-badge { background: rgba(255,255,255,0.08); }
body.vscode-light .try-tool-badge { background: rgba(0,0,0,0.06); }

.try-prompt {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
  line-height: 1.5;
  padding: 8px 10px;
  border-radius: 6px;
  margin-top: 6px;
  white-space: pre-wrap;
  word-break: break-word;
}
body.vscode-dark .try-prompt { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); }
body.vscode-light .try-prompt { background: rgba(0,0,0,0.03); border: 1px solid rgba(0,0,0,0.06); }

.try-prompt .cmd {
  color: var(--accent);
  font-weight: 600;
}
.try-prompt .query { opacity: 0.7; }

.try-desc {
  font-size: 11px;
  opacity: 0.45;
  margin-top: 4px;
  line-height: 1.4;
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
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 6px;
  padding: 14px 14px;
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

/* ── Install pipeline ────────────────────── */
.install-pipeline {
  position: relative;
  padding-left: 32px;
}
.install-pipeline::before {
  content: '';
  position: absolute;
  left: 11px;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--border);
  transition: background 0.3s;
}
.install-pipeline.all-done::before {
  background: var(--success);
}

.pipeline-item {
  position: relative;
  padding: 0 0 28px 0;
  animation: step-enter-forward 0.3s cubic-bezier(0.22, 1, 0.36, 1);
}
.pipeline-item:last-child { padding-bottom: 0; }

/* Pipeline node dot */
.pipeline-node {
  position: absolute;
  left: -32px;
  top: 2px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
  transition: all 0.3s ease;
}

.pipeline-node.queued {
  background: var(--card-bg);
  border: 2px solid var(--border);
}
.pipeline-node.queued::after {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--border);
}

.pipeline-node.active {
  background: var(--accent);
  border: 2px solid var(--accent);
  box-shadow: 0 0 0 4px rgba(var(--glow-color), 0.15);
  animation: pulse-ring 2s ease-in-out infinite;
}
.pipeline-node.active svg { color: #000; }

.pipeline-node.success {
  background: var(--success);
  border: 2px solid var(--success);
  animation: check-pop 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}

.pipeline-node.error {
  background: var(--error);
  border: 2px solid var(--error);
}

.pipeline-node svg { width: 12px; height: 12px; }

/* Pipeline card content */
.pipeline-card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 10px;
  overflow: hidden;
  transition: all 0.25s ease;
}
.pipeline-item.active .pipeline-card {
  border-color: var(--accent);
  box-shadow: 0 4px 20px rgba(var(--glow-color), 0.08);
}
.pipeline-item.success .pipeline-card {
  border-color: rgba(var(--glow-success), 0.3);
}
.pipeline-item.error .pipeline-card {
  border-color: rgba(241, 76, 76, 0.3);
}

.pipeline-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
}

.pipeline-icon {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.2s;
}
body.vscode-dark .pipeline-icon { background: rgba(255,255,255,0.06); }
body.vscode-light .pipeline-icon { background: rgba(0,0,0,0.04); }
.pipeline-item.active .pipeline-icon { background: rgba(var(--glow-color), 0.1); }
.pipeline-item.success .pipeline-icon { background: rgba(var(--glow-success), 0.1); }
.pipeline-icon svg { width: 16px; height: 16px; opacity: 0.6; }
.pipeline-item.active .pipeline-icon svg { opacity: 1; color: var(--accent); }
.pipeline-item.success .pipeline-icon svg { opacity: 1; color: var(--success); }

.pipeline-info { flex: 1; min-width: 0; }
.pipeline-name { font-weight: 600; font-size: 13px; }
.pipeline-status {
  font-size: 11px;
  opacity: 0.5;
  margin-top: 2px;
  transition: all 0.2s;
}
.pipeline-item.active .pipeline-status { opacity: 0.8; color: var(--accent); }
.pipeline-item.success .pipeline-status { opacity: 1; color: var(--success); }
.pipeline-item.error .pipeline-status { opacity: 1; color: var(--error); }

.pipeline-badge {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 10px;
  flex-shrink: 0;
}
.pipeline-badge.queued { background: rgba(128,128,128,0.1); opacity: 0.4; }
.pipeline-badge.active { background: rgba(var(--glow-color), 0.12); color: var(--accent); }
.pipeline-badge.success { background: rgba(var(--glow-success), 0.12); color: var(--success); }
.pipeline-badge.error { background: rgba(241,76,76,0.12); color: var(--error); }

/* Pipeline terminal log */
.pipeline-log {
  border-top: 1px solid var(--border);
  padding: 10px 16px 12px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
  line-height: 1.6;
  max-height: 80px;
  overflow-y: auto;
  transition: max-height 0.3s ease;
}
.pipeline-log .log-line {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.4;
  transition: opacity 0.15s;
}
.pipeline-log .log-line:last-child { opacity: 0.8; color: var(--accent); }
.pipeline-log .log-cursor {
  display: inline;
  animation: blink 1s step-end infinite;
  color: var(--accent);
}
.pipeline-item.success .pipeline-log { display: none; }
.pipeline-item.error .pipeline-log .log-line:last-child { color: var(--error); }

/* Pipeline overall progress bar */
.pipeline-progress-wrap {
  margin-bottom: 24px;
}
.pipeline-progress-label {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 8px;
}
.pipeline-progress-text {
  font-size: 12px;
  font-weight: 500;
  opacity: 0.6;
  transition: all 0.3s;
}
.pipeline-progress-text.done { opacity: 1; color: var(--success); }
.pipeline-progress-pct {
  font-size: 24px;
  font-weight: 300;
  letter-spacing: -1px;
  transition: color 0.3s;
}
.pipeline-progress-pct.done { color: var(--success); }
.pipeline-track {
  height: 3px;
  border-radius: 2px;
  overflow: hidden;
}
body.vscode-dark .pipeline-track { background: rgba(255,255,255,0.08); }
body.vscode-light .pipeline-track { background: rgba(0,0,0,0.06); }
.pipeline-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
  transition: width 0.5s cubic-bezier(0.22, 1, 0.36, 1);
  position: relative;
}
.pipeline-fill::after {
  content: '';
  position: absolute;
  right: 0;
  top: -1px;
  width: 20px;
  height: 5px;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.4));
  border-radius: 2px;
  animation: shimmer 1.5s infinite;
}
.pipeline-fill.done { background: var(--success); }
.pipeline-fill.done::after { display: none; }

@keyframes shimmer {
  0% { opacity: 0; }
  50% { opacity: 1; }
  100% { opacity: 0; }
}

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
const STEPS = ['Welcome', 'Sign In', 'APIs', 'Credentials', 'Wire', 'Live Proof', 'Done'];

let loginEmail = '';
let registryAdapters = [];
let registrySkills = [];
let selectedAdapters = new Set();
let installedAdapters = [];
let tokenRequirements = [];
let selectedWireClients = new Set();
let totalFlowsInstalled = 0;
let proofResults = {};

const POPULAR = ['github', 'gmail', 'calendar', 'stripe'];
const MAX_ADAPTERS = 8;
var wizardStartTime = Date.now();

const WIRE_CLIENTS = [
  { id: 'dex-skill-claude-code', name: 'Claude Code', desc: 'Wire dex MCP tools into Anthropic Claude Code',
    icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/></svg>' },
  { id: 'dex-skill-cursor', name: 'Cursor', desc: 'Wire dex MCP tools into Cursor AI IDE',
    icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"/></svg>' },
  { id: 'dex-skill-codex', name: 'Codex', desc: 'Wire dex MCP tools into OpenAI Codex CLI',
    icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>' },
  { id: 'dex-agents-md', name: 'AGENTS.md', desc: 'Generate an AGENTS.md reference for any AI tool',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/><line x1="8" y1="9" x2="10" y2="9"/></svg>' },
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
    case 'resume-at-step':
      currentStep = msg.step;
      renderStep();
      break;
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
    case 'waitlist-status':
      handleWaitlistStatus(msg);
      break;
    case 'join-status':
      handleJoinStatus(msg);
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
      <div class="hero-wordmark">
        <span style="font-size:36px; font-weight:300; letter-spacing:-0.5px;">modiq<span style="display:inline-block; width:0.52em; height:0.52em; background:#E87A2A; border-radius:50%; vertical-align:baseline; margin:0 0.01em; position:relative; top:-0.05em;"></span></span>
        <span style="font-size:36px; font-weight:200; letter-spacing:-0.5px; opacity:0.45; margin-left:10px;">dex</span>
      </div>
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
    <div class="journey-page">
      <!-- Section 1: Join the Waitlist -->
      <div class="journey-section" id="sect-waitlist">
        <div class="journey-header" onclick="toggleSection('waitlist')">
          <div class="journey-step-num">1</div>
          <div class="journey-step-info">
            <div class="journey-step-title">Join the waitlist</div>
            <div class="journey-step-hint">New here? Request early access</div>
          </div>
          <div class="journey-chevron" id="chevron-waitlist">\\u25BC</div>
        </div>
        <div class="journey-body" id="body-waitlist">
          <div class="journey-input-row">
            <input type="email" id="waitlistEmail" class="journey-input" placeholder="you@company.com" autocomplete="email" />
            <button class="btn btn-primary" id="waitlistBtn" onclick="submitWaitlist()">Request Access</button>
          </div>
          <div class="journey-field-hint" id="waitlistHint">Check your email (and spam folder) within the next 7 days</div>
          <div id="waitlistStatus"></div>
        </div>
      </div>

      <!-- Section 2: Claim your Invite -->
      <div class="journey-section" id="sect-invite">
        <div class="journey-header" onclick="toggleSection('invite')">
          <div class="journey-step-num">2</div>
          <div class="journey-step-info">
            <div class="journey-step-title">Claim your invite</div>
            <div class="journey-step-hint">Already have a code? Activate it here</div>
          </div>
          <div class="journey-chevron" id="chevron-invite">\\u25B6</div>
        </div>
        <div class="journey-body collapsed" id="body-invite">
          <div class="journey-input-row">
            <input type="text" id="inviteCode" class="journey-input" placeholder="abc123-def456-ghi789" spellcheck="false" />
            <button class="btn btn-primary" id="inviteBtn" onclick="submitInvite()">Claim</button>
          </div>
          <div id="inviteStatus"></div>
        </div>
      </div>

      <!-- Section 3: Sign In -->
      <div class="journey-section" id="sect-signin">
        <div class="journey-header" onclick="toggleSection('signin')">
          <div class="journey-step-num">3</div>
          <div class="journey-step-info">
            <div class="journey-step-title">Sign in</div>
            <div class="journey-step-hint">Already invited? Authenticate to continue</div>
          </div>
          <div class="journey-chevron" id="chevron-signin">\\u25B6</div>
        </div>
        <div class="journey-body collapsed" id="body-signin">
          <div class="provider-cards" style="margin:12px 0 16px;">
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
        </div>
      </div>
    </div>
    <div class="btn-row-right">
      <button class="btn btn-ghost" onclick="next()">Skip for now</button>
    </div>
  \`;

  // Auto-open waitlist section
  document.getElementById('waitlistEmail')?.focus();
}

let openSection = 'waitlist';

function toggleSection(id) {
  const sections = ['waitlist', 'invite', 'signin'];
  sections.forEach(s => {
    const body = document.getElementById('body-' + s);
    const chev = document.getElementById('chevron-' + s);
    if (s === id && body.classList.contains('collapsed')) {
      body.classList.remove('collapsed');
      if (chev) chev.textContent = '\\u25BC';
      openSection = id;
    } else if (s !== id) {
      body.classList.add('collapsed');
      if (chev) chev.textContent = '\\u25B6';
    }
  });
}

function validateEmail(email) {
  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
}

function submitWaitlist() {
  const input = document.getElementById('waitlistEmail');
  const btn = document.getElementById('waitlistBtn');
  const status = document.getElementById('waitlistStatus');
  const email = input.value.trim();

  if (!validateEmail(email)) {
    status.innerHTML = '<div class="journey-error">Please enter a valid email address</div>';
    input.classList.add('input-error');
    return;
  }

  input.classList.remove('input-error');
  btn.disabled = true;
  btn.classList.add('loading');
  btn.textContent = 'Sending...';
  status.innerHTML = '';

  vscode.postMessage({ type: 'waitlist', email });
}

function submitInvite() {
  const input = document.getElementById('inviteCode');
  const btn = document.getElementById('inviteBtn');
  const status = document.getElementById('inviteStatus');
  const code = input.value.trim();

  if (!code || code.length < 4) {
    status.innerHTML = '<div class="journey-error">Please enter a valid invite code</div>';
    input.classList.add('input-error');
    return;
  }

  input.classList.remove('input-error');
  btn.disabled = true;
  btn.classList.add('loading');
  btn.textContent = 'Verifying...';
  status.innerHTML = '';

  vscode.postMessage({ type: 'join-invite', code });
}

function handleWaitlistStatus(msg) {
  const btn = document.getElementById('waitlistBtn');
  const status = document.getElementById('waitlistStatus');
  if (!btn || !status) return;

  btn.disabled = false;
  btn.classList.remove('loading');
  btn.textContent = 'Request Access';

  if (msg.success) {
    status.innerHTML = '<div class="journey-success">\\u2713 Request sent! Check your inbox (and spam folder) in the next 7 days.</div>';
    btn.textContent = 'Sent';
    btn.disabled = true;
    // Auto-open invite section after success
    setTimeout(() => toggleSection('invite'), 1500);
  } else {
    status.innerHTML = '<div class="journey-error">' + escapeHtml(msg.message) + '</div>';
  }
}

function handleJoinStatus(msg) {
  const btn = document.getElementById('inviteBtn');
  const status = document.getElementById('inviteStatus');
  if (!btn || !status) return;

  btn.disabled = false;
  btn.classList.remove('loading');
  btn.textContent = 'Claim';

  if (msg.success) {
    status.innerHTML = '<div class="journey-success">\\u2713 Invite claimed!' + (msg.email ? ' Welcome, ' + escapeHtml(msg.email) + '.' : '') + ' Now sign in below.</div>';
    btn.textContent = 'Claimed';
    btn.disabled = true;
    // Auto-open sign-in section
    setTimeout(() => toggleSection('signin'), 1200);
  } else {
    status.innerHTML = '<div class="journey-error">' + escapeHtml(msg.message) + '</div>';
  }
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

// ── Step 2: Adapter Catalog ───────────────

const ADAPTER_CATEGORIES = {
  'Communication': ['gmail', 'slack', 'calendar', 'elevenlabs'],
  'Development': ['github', 'linear', 'cloudflare'],
  'Knowledge': ['notion', 'googledocs'],
  'Search': ['exasearch', 'parallelweb'],
  'Data & Analytics': ['stripe', 'astronomer', 'drive-api-v3'],
  'AI & Automation': ['gemini-api', 'manusai'],
};

const ADAPTER_ICONS = {
  github: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
  gmail: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h12a1 1 0 011 1v8a1 1 0 01-1 1H2a1 1 0 01-1-1V4a1 1 0 011-1zm0 1.5v7h12v-7L8 9 2 4.5zm.5-.5L8 7.5 13.5 4h-11z"/></svg>',
  stripe: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 4a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V4zm5.5 1.5c-.83 0-1.5.28-1.5.75 0 .78 1.13.88 2.25 1.12C9.5 7.63 11 8 11 9.5 11 11.15 9.5 12 7.75 12c-1.08 0-2.19-.33-3-.83l.5-1.17c.67.42 1.58.75 2.5.75.83 0 1.5-.28 1.5-.75 0-.78-1.13-.88-2.25-1.12C5.75 8.62 4.5 8.25 4.5 6.75 4.5 5.1 6 4.25 7.5 4.25c.92 0 1.83.25 2.5.58l-.5 1.17c-.5-.28-1.25-.5-2-.5z"/></svg>',
  notion: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3.3 1.5l7.2-.5c.9-.07 1.1 0 1.7.4l2.3 1.6c.4.3.5.4.5.7v9.2c0 .6-.2.9-1 1l-7.8.5c-.6 0-.8-.1-1.1-.4L2.9 11c-.4-.5-.5-.8-.5-1.3V2.8c0-.6.2-1.1.9-1.3zM10 3.6v7.4l-5.4.3V4.2L10 3.6zM9.6 2.3L5 2.7l-.2.1v.3l5.2-.5-.1-.2-.3-.1z"/></svg>',
  linear: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.62 10.76a7.98 7.98 0 003.62 3.62L1.62 10.76zm.55-1.72a8 8 0 004.79 4.79L1.5 8.37a3.6 3.6 0 00.67.67zm1.28-1.28a8 8 0 005.31 5.31c.5-.1.97-.25 1.42-.45L2.63 5.07c-.2.45-.35.92-.45 1.42l.27.27zm1.5-2.35l6.64 6.64a8 8 0 001.25-1.21L4.79 5.79l-.84.62zM5.79 4.16l6.05 6.05A8 8 0 0013.75 8c0-3.87-2.75-7.1-6.4-7.84L5.79 4.16zM8.02.07A8 8 0 0115.93 8c0 1.56-.45 3.02-1.22 4.25L8.02.07z"/></svg>',
  calendar: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 1v1H3a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V3a1 1 0 00-1-1h-2V1h-1v1H6V1H5zm-2 4h10v8H3V5zm2 2v1h2V7H5zm3 0v1h2V7H8zm-3 3v1h2v-1H5zm3 0v1h2v-1H8z"/></svg>',
  cloudflare: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M11.3 11.5H4a.5.5 0 010-1l7-.1c.5 0 1-.4 1.1-.9l.2-.8c0-.1 0-.2-.1-.3-.7-2-2.5-3.4-4.7-3.4-2.4 0-4.4 1.7-4.9 3.9-.4-.3-.9-.4-1.4-.3-.9.1-1.6.9-1.7 1.8 0 .2 0 .4.1.6C.2 11.3.7 11.5 1.3 11.5H2"/><path d="M13 8.8c.1-.3-.1-.5-.3-.5h-1c-.2 0-.3.1-.4.2l-.3 1.1c-.1.3.1.5.3.5h1.2c.1 0 .3-.1.3-.2l.2-1.1z"/></svg>',
  elevenlabs: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="6" y="2" width="2" height="12" rx="1"/><rect x="10" y="2" width="2" height="12" rx="1"/></svg>',
  'gemini-api': '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zM6.5 5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm3 0a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM4.5 9h7a.5.5 0 01.4.8A4.48 4.48 0 018 12a4.48 4.48 0 01-3.9-2.2.5.5 0 01.4-.8z"/></svg>',
  googledocs: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1zm4.5 1H4v12h8V5.5H8.5V2zM5 8h6v1H5V8zm0 2h6v1H5v-1zm0 2h4v1H5v-1z"/></svg>',
  exasearch: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 1a5.5 5.5 0 014.38 8.82l3.15 3.15a.75.75 0 01-1.06 1.06l-3.15-3.15A5.5 5.5 0 116.5 1zm0 1.5a4 4 0 100 8 4 4 0 000-8z"/></svg>',
  manusai: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l1.5 3.5L13 6l-3 2.5.5 3.5L8 10.5 5.5 12l.5-3.5L3 6l3.5-1.5L8 1z"/></svg>',
  parallelweb: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="3" width="4" height="10" rx="1"/><rect x="6" y="1" width="4" height="14" rx="1"/><rect x="11" y="4" width="4" height="8" rx="1"/></svg>',
  astronomer: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="5" r="2.5"/><path d="M3 14c0-2.76 2.24-5 5-5s5 2.24 5 5"/><circle cx="12" cy="3" r="1"/></svg>',
  'drive-api-v3': '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.34 11.5L5.84 3h4.32l-4.5 8.5H1.34zM10.16 3l4.5 8.5h-4.32L5.84 3h4.32zM8 9.5l2.16 4H5.84L8 9.5z"/></svg>',
  slack: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6 1a1.5 1.5 0 00-.15 2.99H7.5V2.5A1.5 1.5 0 006 1zM2.5 6A1.5 1.5 0 001 7.5 1.5 1.5 0 002.5 9h1.49V7.5A1.5 1.5 0 002.5 6zM10 13.01A1.5 1.5 0 0010.15 10H8.5v1.49c0 .84.67 1.52 1.5 1.52zM13.5 10A1.5 1.5 0 0015 8.5 1.5 1.5 0 0013.5 7h-1.49v1.5c0 .83.67 1.5 1.49 1.5zM7.5 13.5V12H6a1.5 1.5 0 000 3c.83 0 1.5-.67 1.5-1.5zM7.5 4h1.49A1.5 1.5 0 007.5 2.5V4zM12 7.5v1.49A1.5 1.5 0 0013.5 7.5H12zM4 8.5V7H2.5A1.5 1.5 0 004 8.5zM8.5 4V2.5A1.5 1.5 0 0110 4v1.49H8.5V4zM6 7h4v2H6V7z"/></svg>',
};

function adapterIcon(name) {
  if (ADAPTER_ICONS[name]) return ADAPTER_ICONS[name];
  // Fallback: generic API icon
  return '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 1.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11zM7 5v2H5v2h2v2h2V9h2V7H9V5H7z"/></svg>';
}

function categorizeAdapters(adapters) {
  const categorized = {};
  const placed = new Set();
  for (const [cat, names] of Object.entries(ADAPTER_CATEGORIES)) {
    const items = adapters.filter(a => names.includes(a.name));
    if (items.length > 0) {
      categorized[cat] = items;
      items.forEach(i => placed.add(i.name));
    }
  }
  const uncategorized = adapters.filter(a => !placed.has(a.name));
  if (uncategorized.length > 0) {
    categorized['Other'] = uncategorized;
  }
  return categorized;
}

function renderAdapters(el) {
  if (registryAdapters.length === 0) {
    el.innerHTML = \`
      <h2 style="font-weight:300; letter-spacing:-0.5px;">API Catalog</h2>
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

  // Selection strip
  let strip = '<div class="selection-strip-label">Selected</div>';
  if (selectedAdapters.size === 0) {
    strip = '<div class="selection-strip-label" style="opacity:0.3;">No APIs selected</div>';
  } else {
    for (const name of selectedAdapters) {
      strip += \`<span class="selection-tag" onclick="toggleAdapter('\${name}')">\${name}<span class="tag-x">\\u2715</span></span>\`;
    }
  }

  // Categorized sections
  const cats = categorizeAdapters(registryAdapters);
  let sections = '';
  for (const [cat, items] of Object.entries(cats)) {
    let cards = '';
    for (const a of items) {
      const sel = selectedAdapters.has(a.name) ? 'selected' : '';
      cards += \`
        <div class="catalog-card glow-card \${sel}" onclick="toggleAdapter('\${a.name}')">
          <div class="catalog-icon">\${adapterIcon(a.name)}</div>
          <div class="catalog-body">
            <div class="catalog-name">\${a.name}</div>
            <div class="catalog-desc">\${a.description || ''}</div>
          </div>
          <div class="catalog-toggle">
            <svg class="catalog-toggle-check" width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2 5.5l2 2 4-4" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
        </div>
      \`;
    }
    sections += \`
      <div class="catalog-section">
        <div class="catalog-section-label">\${cat}</div>
        <div class="catalog-grid">\${cards}</div>
      </div>
    \`;
  }

  el.innerHTML = \`
    <h2 style="font-weight:300; letter-spacing:-0.5px;">API Catalog</h2>
    <div class="subtitle" id="adapterSubtitle" style="margin-bottom:16px;">Pick up to 8 to start. You can always add more later.</div>
    <div class="selection-strip" id="selectionStrip">\${strip}</div>
    \${sections}
    \${selectedAdapters.size > 0 ? \`
      <div class="install-bar">
        <div class="install-count">\${selectedAdapters.size} API\${selectedAdapters.size !== 1 ? 's' : ''} selected</div>
        <button class="btn btn-ghost" onclick="selectedAdapters.clear(); renderStep()">Clear all</button>
        <button class="btn btn-primary" onclick="installSelected()" id="installBtn">
          Install \\u2192
        </button>
      </div>
    \` : ''}
  \`;

  // Update subtitle and lock cards based on limit — no nested template literals
  var subtitle = el.querySelector('#adapterSubtitle');
  if (subtitle) {
    var remaining = MAX_ADAPTERS - selectedAdapters.size;
    if (remaining === 0) {
      subtitle.textContent = 'You have reached the limit. Experience dex and add more as you grow.';
    } else if (remaining === 1) {
      subtitle.textContent = 'One more slot left.';
    } else if (remaining <= 3) {
      subtitle.textContent = remaining + ' slots left — start lean, compound fast.';
    } else {
      subtitle.textContent = 'Pick up to 8 to start. You can always add more later.';
    }
  }
  // Grey out unselected cards when at limit
  var allCards = el.querySelectorAll('.catalog-card');
  allCards.forEach(function(card) {
    if (selectedAdapters.size >= MAX_ADAPTERS && !card.classList.contains('selected')) {
      card.style.opacity = '0.35';
      card.style.pointerEvents = 'none';
    } else {
      card.style.opacity = '';
      card.style.pointerEvents = '';
    }
  });
}

function toggleAdapter(name) {
  if (selectedAdapters.has(name)) {
    selectedAdapters.delete(name);
  } else if (selectedAdapters.size < MAX_ADAPTERS) {
    selectedAdapters.add(name);
  }
  renderStep();
}

function installSelected() {
  const adapters = [...selectedAdapters];
  installedAdapters = adapters;

  const stepEl = document.getElementById('stepContainer');
  if (!stepEl) return;

  let items = '';
  for (let i = 0; i < adapters.length; i++) {
    const a = adapters[i];
    items += \`
      <div class="pipeline-item" id="install-\${a}" style="animation-delay: \${i * 60}ms;">
        <div class="pipeline-node queued" id="node-\${a}"></div>
        <div class="pipeline-card">
          <div class="pipeline-header">
            <div class="pipeline-icon">\${adapterIcon(a)}</div>
            <div class="pipeline-info">
              <div class="pipeline-name">\${a}</div>
              <div class="pipeline-status" id="status-\${a}">Waiting</div>
            </div>
            <div class="pipeline-badge queued" id="badge-\${a}">Queued</div>
          </div>
          <div class="pipeline-log" id="log-\${a}" style="display:none;"></div>
        </div>
      </div>
    \`;
  }

  stepEl.innerHTML = \`
    <h2 style="font-weight:300; letter-spacing:-0.5px;">Installing</h2>
    <div class="subtitle">Connecting \${adapters.length} API\${adapters.length !== 1 ? 's' : ''} to your workspace.</div>
    <div class="pipeline-progress-wrap">
      <div class="pipeline-progress-label">
        <span class="pipeline-progress-text" id="progressText">0 of \${adapters.length} complete</span>
        <span class="pipeline-progress-pct" id="progressPct">0%</span>
      </div>
      <div class="pipeline-track"><div class="pipeline-fill" id="progressFill" style="width: 0%;"></div></div>
    </div>
    <div class="install-pipeline" id="installPipeline">\${items}</div>
    <div id="installDoneRow"></div>
  \`;

  vscode.postMessage({ type: 'install-adapters', adapters });
}

function handleInstallProgress(msg) {
  const item = document.getElementById('install-' + msg.adapter);
  if (!item) return;

  const node = document.getElementById('node-' + msg.adapter);
  const badge = document.getElementById('badge-' + msg.adapter);
  const status = document.getElementById('status-' + msg.adapter);
  const logEl = document.getElementById('log-' + msg.adapter);
  const checkSvg = '<svg viewBox="0 0 12 12" fill="none"><path d="M2.5 6.5l2.5 2.5 4.5-5" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const xSvg = '<svg viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>';

  if (msg.status === 'installing') {
    item.className = 'pipeline-item active';
    item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    if (node) { node.className = 'pipeline-node active'; node.innerHTML = '<svg viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="3" fill="#fff"/></svg>'; }
    if (badge) { badge.className = 'pipeline-badge active'; badge.textContent = 'Installing'; }
    if (status) status.textContent = msg.message;

    if (logEl && msg.logs && msg.logs.length > 0) {
      logEl.style.display = '';
      logEl.innerHTML = msg.logs.map(l => '<div class="log-line">' + escapeHtml(l) + '</div>').join('')
        + '<span class="log-cursor">\\u258A</span>';
    }
  } else if (msg.status === 'success') {
    item.className = 'pipeline-item success';
    if (node) { node.className = 'pipeline-node success'; node.innerHTML = checkSvg; }
    if (badge) { badge.className = 'pipeline-badge success'; badge.textContent = msg.message; }
    if (status) status.textContent = 'Complete';
    if (logEl) logEl.style.display = 'none';
    // Track flow count from messages like "Installed (3 flows)"
    var flowMatch = msg.message && msg.message.match(/\\((\\d+)\\s+flow/);
    if (flowMatch) totalFlowsInstalled += parseInt(flowMatch[1], 10);
  } else if (msg.status === 'error') {
    item.className = 'pipeline-item error';
    if (node) { node.className = 'pipeline-node error'; node.innerHTML = xSvg; }
    if (badge) { badge.className = 'pipeline-badge error'; badge.textContent = 'Failed'; }
    if (status) status.textContent = msg.message;
  }

  // Update progress
  const total = installedAdapters.length;
  const allItems = document.querySelectorAll('[id^="install-"]');
  const doneCount = [...allItems].filter(el => el.classList.contains('success') || el.classList.contains('error')).length;
  const pct = Math.round((doneCount / total) * 100);

  const fill = document.getElementById('progressFill');
  const pctEl = document.getElementById('progressPct');
  const textEl = document.getElementById('progressText');
  if (fill) fill.style.width = pct + '%';
  if (pctEl) pctEl.textContent = pct + '%';
  if (textEl) textEl.textContent = doneCount + ' of ' + total + ' complete';

  if (doneCount === total) {
    if (fill) { fill.classList.add('done'); fill.style.width = '100%'; }
    if (pctEl) pctEl.classList.add('done');
    if (textEl) { textEl.classList.add('done'); textEl.textContent = 'All ' + total + ' APIs connected'; }
    const pipeline = document.getElementById('installPipeline');
    if (pipeline) pipeline.classList.add('all-done');

    const doneRow = document.getElementById('installDoneRow');
    if (doneRow) {
      doneRow.innerHTML = '<div class="btn-row-right" style="margin-top:28px;"><button class="btn btn-primary" onclick="next()">Continue \\u2192</button></div>';
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
      <button class="btn btn-primary" onclick="showPassphraseModal()" id="vaultPullBtn" style="min-width:110px;">Pull Vault</button>
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
      if (btn) { btn.textContent = 'Pulled \u2713'; btn.disabled = true; btn.classList.add('btn-success-done'); }
    }
    statusEl.innerHTML = \`
      <div class="vault-status-banner success" style="flex-direction:column; align-items:center; text-align:center;">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <circle cx="10" cy="10" r="9" stroke="var(--success)" stroke-width="1.5" fill="none"/>
          <path d="M6 10.5l2.5 2.5 5.5-5.5" stroke="var(--success)" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <div class="vault-status-title" style="margin-top:6px;">\${escapeHtml(msg.message)}</div>
        <div class="vault-status-hint muted">Tokens below have been updated from the vault.</div>
      </div>
    \`;
    var expiredTokens = (msg.vaultTokens || []).filter(function(t) { return t.expires_in === 'expired'; });
    if (expiredTokens.length > 0) {
      var warn = document.createElement('div');
      warn.style.cssText = 'margin-top:12px;margin-bottom:16px;padding:10px 14px;background:rgba(244,71,71,0.08);border:1px solid var(--error);border-radius:8px;';
      var warnTitle = document.createElement('div');
      warnTitle.style.cssText = 'font-size:12px;font-weight:600;color:var(--error);margin-bottom:6px;';
      warnTitle.textContent = expiredTokens.length + ' token' + (expiredTokens.length > 1 ? 's' : '') + ' may be expired';
      var warnBody = document.createElement('div');
      warnBody.style.cssText = 'font-size:11px;color:var(--fg-dim);line-height:1.5;';
      warnBody.textContent = expiredTokens.map(function(t) { return t.name; }).join(', ') + ' — consider refreshing below.';
      warn.appendChild(warnTitle);
      warn.appendChild(warnBody);
      statusEl.appendChild(warn);
    }
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
        <div class="wire-toggle">
          <svg class="wire-toggle-check" width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2 5.5l2 2 4-4" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div class="wire-brand">\${c.icon}</div>
        <div class="wire-info">
          <div class="wire-name">\${c.name}</div>
          <div class="wire-desc">\${c.desc}</div>
        </div>
      </div>
    \`;
  }

  const stdioServers = [
    { name: 'Playwright', desc: 'Browser automation' },
    { name: 'Chrome DevTools', desc: 'DevTools protocol' },
    { name: 'Filesystem', desc: 'Sandboxed file access' },
  ];
  let mcpItems = stdioServers.map(s => \`
    <div class="mcp-item">
      <div class="mcp-dot"></div>
      <span class="mcp-item-name">\${s.name}</span>
      <span class="mcp-item-desc">\${s.desc}</span>
    </div>
  \`).join('');

  el.innerHTML = \`
    <h2 style="font-weight:300; letter-spacing:-0.5px;">Wire AI Tools</h2>
    <div class="subtitle" style="margin-bottom:20px;">Connect dex to your AI coding tools via MCP.</div>
    <div class="wire-grid">\${cards}</div>
    <div class="mcp-bundle">
      <div class="mcp-bundle-header">
        <div>
          <div class="mcp-bundle-title">MCP Server Bundle</div>
          <div class="mcp-bundle-sub">Auto-configured with every installation</div>
        </div>
        <div class="mcp-bundle-label">Included</div>
      </div>
      \${mcpItems}
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
  const stepEl = document.getElementById('stepContainer');
  if (!stepEl) return;

  let items = '';
  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    const def = WIRE_CLIENTS.find(w => w.id === c);
    items += \`
      <div class="pipeline-item" id="wire-\${c}" style="animation-delay: \${i * 60}ms;">
        <div class="pipeline-node queued" id="wnode-\${c}"></div>
        <div class="pipeline-card">
          <div class="pipeline-header">
            <div class="pipeline-icon">\${def ? def.icon : ''}</div>
            <div class="pipeline-info">
              <div class="pipeline-name">\${def ? def.name : c}</div>
              <div class="pipeline-status" id="wstatus-\${c}">Waiting</div>
            </div>
            <div class="pipeline-badge queued" id="wbadge-\${c}">Queued</div>
          </div>
        </div>
      </div>
    \`;
  }

  stepEl.innerHTML = \`
    <h2 style="font-weight:300; letter-spacing:-0.5px;">Wiring</h2>
    <div class="subtitle">Connecting MCP tools to your AI environment.</div>
    <div class="pipeline-progress-wrap">
      <div class="pipeline-progress-label">
        <span class="pipeline-progress-text" id="wireProgressText">0 of \${clients.length} wired</span>
        <span class="pipeline-progress-pct" id="wireProgressPct">0%</span>
      </div>
      <div class="pipeline-track"><div class="pipeline-fill" id="wireProgressFill" style="width:0%;"></div></div>
    </div>
    <div class="install-pipeline" id="wirePipeline">\${items}</div>
    <div id="wireDoneRow"></div>
  \`;

  vscode.postMessage({ type: 'wire-clients', clients });
}

function handleWireProgress(msg) {
  const item = document.getElementById('wire-' + msg.client);
  if (!item) return;

  const node = document.getElementById('wnode-' + msg.client);
  const badge = document.getElementById('wbadge-' + msg.client);
  const status = document.getElementById('wstatus-' + msg.client);
  const checkSvg = '<svg viewBox="0 0 12 12" fill="none"><path d="M2.5 6.5l2.5 2.5 4.5-5" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const xSvg = '<svg viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>';

  if (msg.status === 'success') {
    item.className = 'pipeline-item success';
    if (node) { node.className = 'pipeline-node success'; node.innerHTML = checkSvg; }
    if (badge) { badge.className = 'pipeline-badge success'; badge.textContent = 'Connected'; }
    if (status) status.textContent = 'Complete';
  } else if (msg.status === 'error') {
    item.className = 'pipeline-item error';
    if (node) { node.className = 'pipeline-node error'; node.innerHTML = xSvg; }
    if (badge) { badge.className = 'pipeline-badge error'; badge.textContent = 'Failed'; }
    if (status) status.textContent = msg.message || 'Error';
  }

  // Update progress
  const total = [...selectedWireClients].length;
  const allItems = document.querySelectorAll('[id^="wire-"]');
  const doneCount = [...allItems].filter(el => el.classList.contains('success') || el.classList.contains('error')).length;
  const pct = Math.round((doneCount / total) * 100);

  const fill = document.getElementById('wireProgressFill');
  const pctEl = document.getElementById('wireProgressPct');
  const textEl = document.getElementById('wireProgressText');
  if (fill) fill.style.width = pct + '%';
  if (pctEl) pctEl.textContent = pct + '%';
  if (textEl) textEl.textContent = doneCount + ' of ' + total + ' wired';

  if (doneCount === total) {
    if (fill) { fill.classList.add('done'); fill.style.width = '100%'; }
    if (pctEl) pctEl.classList.add('done');
    if (textEl) { textEl.classList.add('done'); textEl.textContent = 'All tools connected'; }
    const pipeline = document.getElementById('wirePipeline');
    if (pipeline) pipeline.classList.add('all-done');
    const doneRow = document.getElementById('wireDoneRow');
    if (doneRow) {
      doneRow.innerHTML = '<div class="btn-row-right" style="margin-top:28px;"><button class="btn btn-primary" onclick="next()">Continue \\u2192</button></div>';
    }
  }
}

// ── Step 5: Proof of Life ──────────────────

function renderProof(el) {
  const adapters = installedAdapters.length > 0 ? installedAdapters : [];
  if (adapters.length === 0) {
    el.innerHTML = '<h2 style="font-weight:300;font-size:1.6em;letter-spacing:-0.02em;">Live proof</h2><div class="subtitle" style="color:var(--orange);font-weight:500;opacity:0.9;">No adapters to verify.</div><div class="btn-row-right"><button class="btn btn-primary" onclick="next()">Finish Setup \\u2192</button></div>';
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
          <div class="verify-running muted">Calling live API...</div>
        </div>
      </div>
    \`;
  }

  el.innerHTML = \`
    <h2 style="font-weight:300;font-size:1.6em;letter-spacing:-0.02em;">Live proof</h2>
    <div class="subtitle" style="color:var(--orange);font-weight:500;opacity:0.9;">Real API calls on your data. No model. No tokens. No waiting.</div>
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
    card.dataset.output = msg.output || '';

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
      html += '<button class="btn btn-ghost" style="margin-top:10px;font-size:0.78em;padding:4px 10px;" onclick="showProofOutput(' + "'" + msg.adapter + "'" + ', this)">View full output</button>';
      body.innerHTML = html;
    } else if (body) {
      body.innerHTML = '<div class="verify-result-header">Verified</div>';
    }
  } else if (msg.status === 'error') {
    card.classList.add('error');

    // Status dot → red x
    if (dot) dot.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="8" fill="var(--error)" opacity="0.15"/><path d="M6.5 6.5l5 5M11.5 6.5l-5 5" stroke="var(--error)" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>';

    // Badge
    var noProofFlow = (msg.error || '').indexOf('No proof flow') !== -1;
    if (badge) {
      badge.className = 'verify-badge error';
      badge.textContent = noProofFlow ? 'Create one' : 'Failed';
    }

    // Error display
    if (body) {
      if (noProofFlow) {
        body.innerHTML = '<div class="verify-error-msg">No proof flow yet for this adapter.</div>'
          + '<div class="verify-error-hint"><span>Run <code>dex flow template create</code> to build one</span></div>';
      } else {
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

function showProofOutput(adapter, btn) {
  var existing = document.getElementById('proofModalOverlay');
  if (existing) { existing.remove(); return; }
  var card = btn.closest('.verify-card');
  var output = card ? (card.dataset.output || '') : '';
  var overlay = document.createElement('div');
  overlay.className = 'proof-modal-overlay';
  overlay.id = 'proofModalOverlay';
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
  var modal = document.createElement('div');
  modal.className = 'proof-modal';
  var header = document.createElement('div');
  header.className = 'proof-modal-header';
  var title = document.createElement('div');
  title.className = 'proof-modal-title';
  title.textContent = adapter + ' - live output';
  var closeBtn = document.createElement('button');
  closeBtn.className = 'proof-modal-close';
  closeBtn.textContent = 'x';
  closeBtn.onclick = function() { overlay.remove(); };
  header.appendChild(title);
  header.appendChild(closeBtn);
  var body = document.createElement('div');
  body.className = 'proof-modal-body';
  body.textContent = output;
  var footer = document.createElement('div');
  footer.className = 'proof-modal-footer';
  footer.textContent = 'Deterministic, no model, no tokens.';
  modal.appendChild(header);
  modal.appendChild(body);
  modal.appendChild(footer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// ── Step 6: Complete ───────────────────────

function renderComplete(el) {
  // Stop the Time to Agent timer — we've arrived
  if (ttaIntervalId) { clearInterval(ttaIntervalId); ttaIntervalId = null; }

  const adapterCount = installedAdapters.length;
  const flowCount = totalFlowsInstalled;
  const wiredNames = [...selectedWireClients]
    .map(id => WIRE_CLIENTS.find(w => w.id === id))
    .filter(Boolean)
    .map(w => w.name);

  const claudeIcon = WIRE_CLIENTS.find(w => w.id === 'dex-skill-claude-code')?.icon || '';
  const codexIcon = WIRE_CLIENTS.find(w => w.id === 'dex-skill-codex')?.icon || '';
  const agentsIcon = WIRE_CLIENTS.find(w => w.id === 'dex-agents-md')?.icon || '';

  el.innerHTML = \`
    <div class="complete-hero">
      <div class="complete-logo">\${buildStippleSvg(40)}</div>
      <h1>You're all set</h1>
      <div class="subtitle">modiq<span style="display:inline-block; width:0.52em; height:0.52em; background:#E87A2A; border-radius:50%; vertical-align:baseline; margin:0 0.01em; position:relative; top:-0.05em;"></span> dex is configured and ready to use.</div>
    </div>
    <div class="summary-row">
      <div class="summary-stat">
        <div class="summary-stat-num">\${adapterCount}</div>
        <div class="summary-stat-label">Adapter\${adapterCount !== 1 ? 's' : ''}</div>
      </div>
      <div class="summary-stat">
        <div class="summary-stat-num">\${flowCount}</div>
        <div class="summary-stat-label">Flow\${flowCount !== 1 ? 's' : ''}</div>
      </div>
      <div class="summary-stat" style="flex:1.5;">
        <div class="summary-stat-label" style="font-size:0.85em;">Wired for \${wiredNames.join(' & ')}</div>
      </div>
    </div>

    <!-- Wait what happened? accordion -->
    <div class="done-accordions">

      <div class="done-section" id="done-sect-what">
        <div class="done-header" onclick="toggleDoneSection('what')">
          <div class="done-header-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M11 1L4 11h5l-1 8 7-10h-5l1-8z" stroke="var(--accent)" stroke-width="1.4" fill="none" stroke-linejoin="round"/></svg></div>
          <div class="done-header-info">
            <div class="done-header-title">Wait, what just happened?</div>
            <div class="done-header-hint">You just ran someone else's productivity memory on your own services</div>
          </div>
          <div class="done-chevron" id="done-chev-what">\\u25BC</div>
        </div>
        <div class="done-body" id="done-body-what">
          <div class="done-aha">
            <p class="done-aha-lead">Yep, you read that right.</p>
            <p>A shared <a href="#" onclick="vscode.postMessage({type:'open-sidebar-view',view:'modiqo-flows'});return false;" class="done-link">memory flow</a> borrowed the right <a href="#" onclick="vscode.postMessage({type:'open-sidebar-view',view:'modiqo-adapters'});return false;" class="done-link">API adapter</a>, authenticated with your credentials, and lit up a <a href="#" onclick="vscode.postMessage({type:'open-sidebar-view',view:'modiqo-explore'});return false;" class="done-link">workspace</a> \\u2014 all without writing a single line of glue code.</p>
            <p class="done-aha-kicker">That's the trick: <em>context is the new code.</em></p>
            <div class="done-cta-row">
              <span>Want to build your own?</span>
              <a href="#" onclick="vscode.postMessage({type:'open-sidebar-view',view:'modiqo-catalog'});return false;" class="done-link-btn">Browse the API Catalog \\u2192</a>
            </div>
          </div>
        </div>
      </div>

      <div class="done-section" id="done-sect-try">
        <div class="done-header" onclick="toggleDoneSection('try')">
          <div class="done-header-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 17l2-6 4 4-6 2z" stroke="var(--accent)" stroke-width="1.4" fill="none" stroke-linejoin="round"/><path d="M5 11l4-8c2-3 6-2 8 0s3 6 0 8l-8 4" stroke="var(--accent)" stroke-width="1.4" fill="none" stroke-linecap="round"/><circle cx="12" cy="8" r="1.5" stroke="var(--accent)" stroke-width="1.2" fill="none"/></svg></div>
          <div class="done-header-info">
            <div class="done-header-title">Try it now</div>
            <div class="done-header-hint">Use dex through Claude Code, Codex, or any AI tool</div>
          </div>
          <div class="done-chevron" id="done-chev-try">\\u25B6</div>
        </div>
        <div class="done-body collapsed" id="done-body-try">
          <div class="try-card" style="margin-top:0;">
            <div class="try-icon">\${claudeIcon}</div>
            <div class="try-body">
              <div class="try-tool">Claude Code <span class="try-tool-badge">MCP</span></div>
              <div class="try-prompt"><span class="cmd">/dex</span> <span class="query">fetch my recent emails from the last 10 days</span></div>
              <div class="try-desc">Invoke dex as a slash command. Claude will use your connected APIs automatically.</div>
            </div>
          </div>
          <div class="try-card">
            <div class="try-icon">\${codexIcon}</div>
            <div class="try-body">
              <div class="try-tool">Codex <span class="try-tool-badge">CLI</span></div>
              <div class="try-prompt"><span class="cmd">$dex</span> <span class="query">fetch my rideshare receipts for February 2026</span></div>
              <div class="try-desc">Prefix with $dex in Codex CLI. Dex resolves the right API, auth, and returns structured data.</div>
            </div>
          </div>
          <div class="try-card">
            <div class="try-icon">\${agentsIcon}</div>
            <div class="try-body">
              <div class="try-tool">Any AI Tool <span class="try-tool-badge">AGENTS.md</span></div>
              <div class="try-prompt"><span class="query">learn how to use dex and dex browse to fetch the latest hacker news updates</span></div>
              <div class="try-desc">Any tool that reads AGENTS.md will discover dex capabilities and invoke them on your behalf.</div>
            </div>
          </div>
        </div>
      </div>

      <div class="done-section" id="done-sect-more">
        <div class="done-header" onclick="toggleDoneSection('more')">
          <div class="done-header-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="2" y="2" width="7" height="7" rx="1.5" stroke="var(--accent)" stroke-width="1.4"/><rect x="11" y="2" width="7" height="7" rx="1.5" stroke="var(--accent)" stroke-width="1.4"/><rect x="2" y="11" width="7" height="7" rx="1.5" stroke="var(--accent)" stroke-width="1.4"/><path d="M14.5 12v5M12 14.5h5" stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round"/></svg></div>
          <div class="done-header-info">
            <div class="done-header-title">Start adapting to more</div>
            <div class="done-header-hint">635+ APIs are waiting \\u2014 pick your next adapter</div>
          </div>
          <div class="done-chevron" id="done-chev-more">\\u25B6</div>
        </div>
        <div class="done-body collapsed" id="done-body-more">
          <div class="done-more-grid">
            <div class="done-more-card" onclick="vscode.postMessage({type:'open-sidebar-view',view:'modiqo-catalog'})">
              <div class="done-more-icon"><svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="7.5" cy="7.5" r="5" stroke="var(--fg-dim)" stroke-width="1.3"/><path d="M11.5 11.5l4 4" stroke="var(--fg-dim)" stroke-width="1.3" stroke-linecap="round"/></svg></div>
              <div class="done-more-label">API Catalog</div>
              <div class="done-more-desc">Search and install from 635+ adapters</div>
            </div>
            <div class="done-more-card" onclick="vscode.postMessage({type:'open-sidebar-view',view:'modiqo-adapters'})">
              <div class="done-more-icon"><svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="2" y="4" width="14" height="11" rx="1.5" stroke="var(--fg-dim)" stroke-width="1.3"/><path d="M2 7.5h14M6 4V2.5M12 4V2.5" stroke="var(--fg-dim)" stroke-width="1.3" stroke-linecap="round"/></svg></div>
              <div class="done-more-label">My Adapters</div>
              <div class="done-more-desc">Manage your installed API adapters</div>
            </div>
            <div class="done-more-card" onclick="vscode.postMessage({type:'open-sidebar-view',view:'modiqo-flows'})">
              <div class="done-more-icon"><svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 2v4M9 12v4M5 6h8M5 12h8" stroke="var(--fg-dim)" stroke-width="1.3" stroke-linecap="round"/><circle cx="9" cy="6" r="2" stroke="var(--fg-dim)" stroke-width="1.3"/><circle cx="9" cy="12" r="2" stroke="var(--fg-dim)" stroke-width="1.3"/></svg></div>
              <div class="done-more-label">Flows</div>
              <div class="done-more-desc">Browse shared and custom memory flows</div>
            </div>
            <div class="done-more-card" onclick="vscode.postMessage({type:'open-sidebar-view',view:'modiqo-explore'})">
              <div class="done-more-icon"><svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="2" y="8" width="3" height="7" rx="0.5" stroke="var(--fg-dim)" stroke-width="1.2"/><rect x="7.5" y="5" width="3" height="10" rx="0.5" stroke="var(--fg-dim)" stroke-width="1.2"/><rect x="13" y="3" width="3" height="12" rx="0.5" stroke="var(--fg-dim)" stroke-width="1.2"/></svg></div>
              <div class="done-more-label">Workspaces</div>
              <div class="done-more-desc">See your execution traces and results</div>
            </div>
          </div>
        </div>
      </div>

    </div>

    <div style="text-align:center; margin-top:28px;">
      <button class="btn btn-primary" onclick="finishSetup()">Start using dex \\u2192</button>
    </div>
  \`;

  var elapsedSec = Math.round((Date.now() - wizardStartTime) / 1000);
  var timeStr = elapsedSec < 60 ? (elapsedSec + 's') : (Math.floor(elapsedSec / 60) + 'm ' + (elapsedSec % 60) + 's');
  var funMessages = [
    'Faster than your last standup.',
    'Shorter than a coffee break.',
    'Your APIs were ready before you finished reading.',
    'Less time than it takes to find the right Slack channel.',
    'Configured before the meeting could have started.',
    'Done before most people read the README.'
  ];
  var funMsg = funMessages[Math.floor(elapsedSec / 15) % funMessages.length] || funMessages[0];

  var ttaCard = document.createElement('div');
  ttaCard.style.cssText = 'margin: 28px auto 0; max-width: 340px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 20px 24px; text-align: center; position: relative; overflow: hidden;';
  var ttaAccent = document.createElement('div');
  ttaAccent.style.cssText = 'position: absolute; top: 0; left: 0; right: 0; height: 3px; background: var(--accent); border-radius: 10px 10px 0 0;';
  var ttaLabel = document.createElement('div');
  ttaLabel.style.cssText = 'font-size: 0.68em; text-transform: uppercase; letter-spacing: 0.1em; color: var(--fg-dim); margin-bottom: 8px;';
  ttaLabel.textContent = 'Time to Agent';
  var ttaTm = document.createElement('sup');
  ttaTm.style.cssText = 'font-size: 0.6em; vertical-align: super;';
  ttaTm.textContent = 'TM';
  ttaLabel.appendChild(ttaTm);
  var ttaTime = document.createElement('div');
  ttaTime.style.cssText = 'font-size: 2.8em; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--fg); line-height: 1.1;';
  ttaTime.textContent = timeStr;
  var ttaMsg = document.createElement('div');
  ttaMsg.style.cssText = 'font-size: 0.8em; color: var(--fg-dim); margin-top: 8px; font-style: italic;';
  ttaMsg.textContent = funMsg;
  ttaCard.appendChild(ttaAccent);
  ttaCard.appendChild(ttaLabel);
  ttaCard.appendChild(ttaTime);
  ttaCard.appendChild(ttaMsg);
  el.appendChild(ttaCard);
}

function toggleDoneSection(id) {
  var sections = ['what', 'try', 'more'];
  sections.forEach(function(s) {
    var body = document.getElementById('done-body-' + s);
    var chev = document.getElementById('done-chev-' + s);
    if (s === id && body.classList.contains('collapsed')) {
      body.classList.remove('collapsed');
      if (chev) chev.textContent = '\\u25BC';
    } else if (s !== id) {
      body.classList.add('collapsed');
      if (chev) chev.textContent = '\\u25B6';
    }
  });
}

function finishSetup() {
  vscode.postMessage({ type: 'complete-setup' });
}

// ── Init ───────────────────────────────────

renderStep();

var ttaIntervalId = null;
(function() {
  var timerEl = document.getElementById('ttaTimer');
  function updateTimer() {
    var sec = Math.floor((Date.now() - wizardStartTime) / 1000);
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    var timeStr = (m > 0 ? m + 'm ' : '') + s + 's';
    timerEl.innerHTML = 'Time to Agent<sup style="font-size:0.6em;vertical-align:super;">\u2122</sup>  ' + timeStr;
  }
  updateTimer();
  ttaIntervalId = setInterval(updateTimer, 1000);
})();
`;

// ── Install Panel (standalone dex binary install) ──────────

let currentInstallPanel: vscode.WebviewPanel | undefined;

export function showInstallPanel(
  extensionUri: vscode.Uri,
  onComplete: () => void,
): vscode.WebviewPanel {
  if (currentInstallPanel) {
    currentInstallPanel.reveal();
    return currentInstallPanel;
  }

  const panel = vscode.window.createWebviewPanel(
    "modiqo.installDex",
    "Install dex",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  currentInstallPanel = panel;
  panel.onDidDispose(() => { currentInstallPanel = undefined; });

  panel.webview.html = buildInstallHtml();

  panel.webview.onDidReceiveMessage((msg) => {
    if (msg.type === "install-complete") {
      onComplete();
      panel.dispose();
    }
  });

  return panel;
}

// ── Registry Login Panel ─────────────────────────────────────────────────────
// Shown when registry session expires — same SSO experience as the setup wizard.

let currentLoginPanel: vscode.WebviewPanel | undefined;

export function showRegistryLoginPanel(client: DexClient, onSuccess: () => void): void {
  if (currentLoginPanel) {
    currentLoginPanel.reveal();
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "modiqo.registryLogin",
    "Sign in to dex Registry",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  currentLoginPanel = panel;
  panel.onDidDispose(() => { currentLoginPanel = undefined; });
  panel.webview.html = buildLoginHtml();

  panel.webview.onDidReceiveMessage((msg) => {
    if (msg.type === "login") {
      const child = client.execStream(["login", "--provider", msg.provider]);
      panel.webview.postMessage({ type: "login-status", status: "polling" });

      let attempts = 0;
      const maxAttempts = 60;
      const interval = setInterval(async () => {
        attempts++;
        if (attempts > maxAttempts) {
          clearInterval(interval);
          child.kill();
          panel.webview.postMessage({ type: "login-status", status: "timeout" });
          return;
        }
        try {
          const whoami = await client.registryWhoami();
          if (whoami.status === "valid") {
            clearInterval(interval);
            child.kill();
            panel.webview.postMessage({ type: "login-status", status: "success", email: whoami.email });
            onSuccess();
            setTimeout(() => panel.dispose(), 1500);
          }
        } catch { /* keep polling */ }
      }, 2000);

      panel.onDidDispose(() => { clearInterval(interval); child.kill(); });
    }
  });
}

function buildLoginHtml(): string {
  const GOOGLE_SVG = `<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>`;
  const GITHUB_SVG = `<svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>`;

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
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
    --card-bg: var(--vscode-editorWidget-background, var(--bg));
    --success: var(--vscode-testing-iconPassed, #4caf50);
    --error: var(--vscode-errorForeground, #f44336);
  }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--fg);
    background: var(--bg);
    margin: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
  }
  .container {
    text-align: center;
    max-width: 480px;
    padding: 40px 24px;
    width: 100%;
  }
  .logo {
    font-size: 1.8em;
    font-weight: 700;
    letter-spacing: -0.02em;
    margin-bottom: 6px;
  }
  .logo span { opacity: 0.45; }
  .subtitle {
    color: var(--fg-dim);
    font-size: 0.9em;
    margin-bottom: 36px;
  }
  .session-badge {
    display: inline-block;
    background: color-mix(in srgb, var(--error) 15%, transparent);
    color: var(--error);
    border: 1px solid color-mix(in srgb, var(--error) 30%, transparent);
    border-radius: 20px;
    font-size: 0.78em;
    padding: 3px 12px;
    margin-bottom: 28px;
  }
  .provider-cards {
    display: flex;
    gap: 14px;
    justify-content: center;
    margin-bottom: 24px;
  }
  .provider-card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px 28px;
    cursor: pointer;
    width: 140px;
    transition: border-color 0.15s, transform 0.1s;
    user-select: none;
  }
  .provider-card:hover {
    border-color: var(--accent);
    transform: translateY(-1px);
  }
  .provider-card .icon { margin-bottom: 10px; }
  .provider-card .name { font-weight: 600; font-size: 0.95em; }
  .provider-card .hint { font-size: 0.78em; color: var(--fg-dim); margin-top: 3px; }
  .status {
    min-height: 60px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .spinner {
    width: 24px; height: 24px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .status-text { font-size: 0.88em; color: var(--fg-dim); }
  .success-text { color: var(--success); font-size: 0.9em; }
  .error-text { color: var(--error); font-size: 0.88em; }
  .look-up {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 0.82em; color: var(--fg-dim); margin-top: 4px;
  }
</style>
</head>
<body>
<div class="container">
  <div class="logo">modiq<span>o</span> dex</div>
  <div class="session-badge">Session expired</div>
  <div class="subtitle">Sign in again to continue accessing the registry.</div>
  <div class="provider-cards">
    <div class="provider-card" onclick="doLogin('google')">
      <div class="icon">${GOOGLE_SVG}</div>
      <div class="name">Google</div>
      <div class="hint">Sign in with Google</div>
    </div>
    <div class="provider-card" onclick="doLogin('github')">
      <div class="icon">${GITHUB_SVG}</div>
      <div class="name">GitHub</div>
      <div class="hint">Sign in with GitHub</div>
    </div>
  </div>
  <div class="status" id="status"></div>
</div>
<script>
  const vscode = acquireVsCodeApi();

  function doLogin(provider) {
    document.querySelectorAll('.provider-card').forEach(c => c.style.pointerEvents = 'none');
    vscode.postMessage({ type: 'login', provider });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    const el = document.getElementById('status');
    if (msg.type === 'login-status') {
      if (msg.status === 'polling') {
        el.innerHTML = '<div class="spinner"></div><div class="status-text">Complete sign-in in your browser...</div><div class="look-up"><span>&#8593;</span> Check your browser window</div>';
      } else if (msg.status === 'success') {
        el.innerHTML = '<div class="success-text">&#10003; Signed in as ' + escHtml(msg.email) + '</div>';
      } else if (msg.status === 'timeout') {
        el.innerHTML = '<div class="error-text">Login timed out. Please try again.</div>';
        document.querySelectorAll('.provider-card').forEach(c => c.style.pointerEvents = '');
      }
    }
  });

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
</script>
</body>
</html>`;
}

function buildInstallHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
${CSS}
.install-page { max-width: 560px; margin: 0 auto; padding: 48px 24px; }
#wittySpinner { transition: opacity 0.3s ease; }
</style>
</head>
<body>
  <div class="install-page" id="installPage">
    <div class="complete-hero">
      <h1 style="color: var(--fg); font-weight: 300; letter-spacing: -0.5px;">Installing modiq<span style="display:inline-block; width:0.52em; height:0.52em; background:#E87A2A; border-radius:50%; vertical-align:baseline; margin:0 0.01em; position:relative; top:-0.05em;"></span> dex</h1>
      <div class="subtitle" id="wittySpinner">Warming up the memory engine...</div>
    </div>
    <div class="pipeline-progress-wrap" style="margin-top:32px;">
      <div class="pipeline-progress-label">
        <span class="pipeline-progress-text" id="progressText">Starting</span>
        <span class="pipeline-progress-pct" id="progressPct">0%</span>
      </div>
      <div class="pipeline-track"><div class="pipeline-fill" id="progressFill" style="width:0%;"></div></div>
    </div>
    <div class="install-pipeline" id="installPipeline" style="margin-top:24px;">
      <div class="pipeline-item" id="step-download">
        <div class="pipeline-node active" id="node-download">
          <svg viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="3" fill="#fff"/></svg>
        </div>
        <div class="pipeline-card">
          <div class="pipeline-header">
            <div class="pipeline-icon">
              <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1v8.59L5.71 7.29 4.29 8.71l3 3a1 1 0 001.42 0l3-3-1.42-1.42L8 9.59V1H8zM3 13v1h10v-1H3z"/></svg>
            </div>
            <div class="pipeline-info">
              <div class="pipeline-name">Download</div>
              <div class="pipeline-status" id="status-download">Downloading installer...</div>
            </div>
            <div class="pipeline-badge active" id="badge-download">Running</div>
          </div>
        </div>
      </div>
      <div class="pipeline-item" id="step-binary">
        <div class="pipeline-node queued" id="node-binary"></div>
        <div class="pipeline-card">
          <div class="pipeline-header">
            <div class="pipeline-icon">
              <svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 1h6l3 3v9a2 2 0 01-2 2H4a2 2 0 01-2-2V3a2 2 0 012-2h1zm5 1.5V5h2.5L10 2.5zM6 8h4v1H6V8zm0 2h4v1H6v-1z"/></svg>
            </div>
            <div class="pipeline-info">
              <div class="pipeline-name">dex Binary</div>
              <div class="pipeline-status" id="status-binary">Waiting</div>
            </div>
            <div class="pipeline-badge queued" id="badge-binary">Queued</div>
          </div>
        </div>
      </div>
      <div class="pipeline-item" id="step-deno">
        <div class="pipeline-node queued" id="node-deno"></div>
        <div class="pipeline-card">
          <div class="pipeline-header">
            <div class="pipeline-icon">
              <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 1.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11z"/><circle cx="8" cy="6" r="1.5"/><path d="M8 8.5v3"/></svg>
            </div>
            <div class="pipeline-info">
              <div class="pipeline-name">Memory Runner</div>
              <div class="pipeline-status" id="status-deno">Waiting</div>
            </div>
            <div class="pipeline-badge queued" id="badge-deno">Queued</div>
          </div>
        </div>
      </div>
      <div class="pipeline-item" id="step-sdk">
        <div class="pipeline-node queued" id="node-sdk"></div>
        <div class="pipeline-card">
          <div class="pipeline-header">
            <div class="pipeline-icon">
              <svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 2L1 5.5 4.5 9l1-1L3 5.5 5.5 3l-1-1zm7 0l-1 1L13 5.5 10.5 8l1 1L15 5.5 11.5 2zM6 12l2-10h1.5l-2 10H6z"/></svg>
            </div>
            <div class="pipeline-info">
              <div class="pipeline-name">Memory Templates</div>
              <div class="pipeline-status" id="status-sdk">Waiting</div>
            </div>
            <div class="pipeline-badge queued" id="badge-sdk">Queued</div>
          </div>
        </div>
      </div>
    </div>
    <div id="installDoneRow"></div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const STEPS = ['download', 'binary', 'deno', 'sdk'];
    const checkSvg = '<svg viewBox="0 0 12 12" fill="none"><path d="M2.5 6.5l2.5 2.5 4.5-5" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    function activateStep(id) {
      const item = document.getElementById('step-' + id);
      const node = document.getElementById('node-' + id);
      const badge = document.getElementById('badge-' + id);
      const status = document.getElementById('status-' + id);
      if (item) item.classList.add('active');
      if (node) { node.className = 'pipeline-node active'; node.innerHTML = '<svg viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="3" fill="#fff"/></svg>'; }
      if (badge) { badge.className = 'pipeline-badge active'; badge.textContent = 'Running'; }
      if (status) status.textContent = 'Installing...';
    }

    function completeStep(id) {
      const item = document.getElementById('step-' + id);
      const node = document.getElementById('node-' + id);
      const badge = document.getElementById('badge-' + id);
      const status = document.getElementById('status-' + id);
      if (item) { item.classList.remove('active'); item.classList.add('success'); }
      if (node) { node.className = 'pipeline-node success'; node.innerHTML = checkSvg; }
      if (badge) { badge.className = 'pipeline-badge success'; badge.textContent = 'Done'; }
      if (status) status.textContent = 'Complete';
    }

    function failStep(id, msg) {
      const item = document.getElementById('step-' + id);
      const node = document.getElementById('node-' + id);
      const badge = document.getElementById('badge-' + id);
      const status = document.getElementById('status-' + id);
      if (item) { item.classList.remove('active'); item.classList.add('error'); }
      if (node) { node.className = 'pipeline-node error'; node.innerHTML = '<svg viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>'; }
      if (badge) { badge.className = 'pipeline-badge error'; badge.textContent = 'Failed'; }
      if (status) status.textContent = msg || 'Error';
    }

    function updateProgress(done, total) {
      const pct = Math.round((done / total) * 100);
      const fill = document.getElementById('progressFill');
      const pctEl = document.getElementById('progressPct');
      const textEl = document.getElementById('progressText');
      if (fill) fill.style.width = pct + '%';
      if (pctEl) pctEl.textContent = pct + '%';
      if (textEl) textEl.textContent = done + ' of ' + total + ' complete';
    }

    // Witty rotating messages inspired by "How it works"
    const wittyMessages = [
      'Warming up the memory engine...',
      'Teaching APIs to remember things...',
      'Encoding context into long-term memory...',
      'Giving your APIs photographic recall...',
      'Wiring neurons between your services...',
      'Building bridges to 635+ APIs...',
      'Compiling muscle memory for your workflows...',
      'Storing retrieval cues for later...',
      'Indexing the collective API unconscious...',
      'Preparing episodic memory buffers...',
    ];
    let wittyIdx = 0;
    const wittyEl = document.getElementById('wittySpinner');
    const wittyInterval = setInterval(() => {
      wittyIdx = (wittyIdx + 1) % wittyMessages.length;
      if (wittyEl) {
        wittyEl.style.opacity = '0';
        setTimeout(() => {
          wittyEl.textContent = wittyMessages[wittyIdx];
          wittyEl.style.opacity = '1';
        }, 300);
      }
    }, 3000);

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'install-step') {
        activateStep(msg.step);
        // Complete previous steps
        const idx = STEPS.indexOf(msg.step);
        for (let i = 0; i < idx; i++) completeStep(STEPS[i]);
        updateProgress(idx, STEPS.length);
      } else if (msg.type === 'install-done') {
        clearInterval(wittyInterval);
        if (wittyEl) wittyEl.textContent = 'All set — your memory layer is ready.';
        STEPS.forEach(s => completeStep(s));
        updateProgress(STEPS.length, STEPS.length);
        const fill = document.getElementById('progressFill');
        const pctEl = document.getElementById('progressPct');
        const textEl = document.getElementById('progressText');
        if (fill) fill.classList.add('done');
        if (pctEl) pctEl.classList.add('done');
        if (textEl) { textEl.classList.add('done'); textEl.textContent = 'Installation complete'; }
        const pipeline = document.getElementById('installPipeline');
        if (pipeline) pipeline.classList.add('all-done');
        const done = document.getElementById('installDoneRow');
        if (done) {
          done.innerHTML = '<div style="text-align:center; margin-top:28px;"><button class="btn btn-primary" onclick="vscode.postMessage({type:\\'install-complete\\'})">Begin Setup \\u2192</button></div>';
        }
      } else if (msg.type === 'install-error') {
        clearInterval(wittyInterval);
        if (wittyEl) wittyEl.textContent = 'Something went wrong.';
        failStep(msg.step || 'download', msg.message);
        const textEl = document.getElementById('progressText');
        if (textEl) { textEl.textContent = 'Installation failed'; textEl.style.color = 'var(--error)'; }
        const done = document.getElementById('installDoneRow');
        if (done) {
          done.innerHTML = '<div style="text-align:center; margin-top:28px;"><div class="muted" style="margin-bottom:8px;">Try running manually:</div><div class="try-prompt" style="display:inline-block;"><code>curl -fsSL https://raw.githubusercontent.com/modiqo/dex-releases/main/install.sh | bash</code></div></div>';
        }
      }
    });
  </script>
</body>
</html>`;
}

