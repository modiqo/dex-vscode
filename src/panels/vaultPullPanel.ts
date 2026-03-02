import * as vscode from "vscode";
import type { DexClient } from "../client/dexClient";

let currentPanel: vscode.WebviewPanel | undefined;

/**
 * Show a styled vault passphrase panel (matches the setup wizard modal UX).
 * Used for post-setup vault pulls (e.g., after token expiry).
 */
export function showVaultPullPanel(
  client: DexClient,
  onSuccess?: () => void,
): void {
  if (currentPanel) {
    currentPanel.reveal();
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "modiqo.vaultPull",
    "Pull Vault",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: false },
  );

  currentPanel = panel;
  panel.onDidDispose(() => { currentPanel = undefined; });

  panel.webview.html = buildHtml();

  panel.webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
      case "vault-pull": {
        const passphrase = msg.passphrase as string;
        if (!passphrase) {
          panel.webview.postMessage({ type: "result", success: false, message: "No passphrase provided" });
          break;
        }

        const success = await client.vaultPull(passphrase);
        if (success) {
          panel.webview.postMessage({ type: "result", success: true, message: "Vault pulled — tokens restored" });
          onSuccess?.();
          // Auto-close after brief delay so user sees the success state
          setTimeout(() => { panel.dispose(); }, 1500);
        } else {
          panel.webview.postMessage({ type: "result", success: false, message: "Vault pull failed. Check passphrase." });
        }
        break;
      }
      case "cancel": {
        panel.dispose();
        break;
      }
    }
  });
}

function buildHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root {
  --fg: var(--vscode-foreground);
  --bg: var(--vscode-editor-background);
  --border: var(--vscode-panel-border, #333);
  --accent: var(--vscode-textLink-foreground, #4fc1ff);
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
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
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

@keyframes modal-in {
  from { opacity: 0; transform: translateY(12px) scale(0.97); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
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

.btn-row {
  display: flex;
  gap: 8px;
  margin-top: 20px;
  justify-content: flex-end;
}

.btn {
  padding: 8px 20px;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s ease, opacity 0.15s ease;
}
.btn:disabled { opacity: 0.5; cursor: default; }

.btn-primary {
  background: var(--btn-bg);
  color: var(--btn-fg);
}
.btn-primary:hover:not(:disabled) { background: var(--btn-hover); }

.btn-secondary {
  background: var(--btn-secondary-bg);
  color: var(--btn-secondary-fg);
}

.status-msg {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  font-size: 12px;
  animation: modal-in 0.2s ease;
}
.status-msg.success { color: var(--success); }
.status-msg.error { color: var(--error); }

.spinner {
  width: 14px; height: 14px;
  border: 2px solid rgba(var(--glow-color), 0.2);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="modal-box">
    <h3>\u{1F512} Vault Passphrase</h3>
    <p class="modal-desc">Your passphrase decrypts the token vault locally.</p>
    <input type="password" class="passphrase-input" id="passphraseInput"
           placeholder="Enter passphrase..." autocomplete="off"/>
    <div class="modal-trust">\u{1F513} Encrypted locally &middot; Never transmitted</div>
    <div id="statusArea"></div>
    <div class="btn-row">
      <button class="btn btn-secondary" id="cancelBtn" onclick="cancel()">Cancel</button>
      <button class="btn btn-primary" id="unlockBtn" onclick="submit()">Unlock \u2192</button>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const input = document.getElementById('passphraseInput');
    const statusArea = document.getElementById('statusArea');
    const unlockBtn = document.getElementById('unlockBtn');
    const cancelBtn = document.getElementById('cancelBtn');

    input.focus();

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') cancel();
    });

    function submit() {
      const passphrase = input.value;
      if (!passphrase) return;
      unlockBtn.disabled = true;
      cancelBtn.disabled = true;
      input.disabled = true;
      statusArea.innerHTML = '<div class="status-msg"><div class="spinner"></div><span>Pulling vault...</span></div>';
      vscode.postMessage({ type: 'vault-pull', passphrase });
    }

    function cancel() {
      vscode.postMessage({ type: 'cancel' });
    }

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'result') {
        if (msg.success) {
          statusArea.innerHTML = '<div class="status-msg success"><svg width="16" height="16" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M6 10.5l2.5 2.5 5.5-5.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg><span>' + escapeHtml(msg.message) + '</span></div>';
        } else {
          statusArea.innerHTML = '<div class="status-msg error"><svg width="16" height="16" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="8" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M6 6l6 6M12 6l-6 6" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg><span>' + escapeHtml(msg.message) + '</span></div>';
          unlockBtn.disabled = false;
          cancelBtn.disabled = false;
          input.disabled = false;
          input.value = '';
          input.focus();
        }
      }
    });

    function escapeHtml(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }
  </script>
</body>
</html>`;
}
