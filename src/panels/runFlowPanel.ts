import * as vscode from "vscode";
import * as fs from "fs";

export interface FlowParam {
  name: string;
  type: string;
  required: boolean;
  default?: string;
  description?: string;
}

export interface FlowInfo {
  name: string;
  path: string;
  description?: string;
  params: FlowParam[];
}

/** Parse @dex-frontmatter YAML block from a flow's main.ts */
export function parseFlowFrontmatter(flowPath: string): FlowInfo {
  const name = flowPath.split("/").slice(-2)[0] ?? "flow";
  const info: FlowInfo = { name, path: flowPath, params: [] };

  let source: string;
  try {
    source = fs.readFileSync(flowPath, "utf-8");
  } catch {
    return info;
  }

  // Extract the YAML block between @dex-frontmatter\n * ---\n and the closing * ---
  const fmMatch = source.match(/@dex-frontmatter\s*\n\s*\*\s*---\n([\s\S]*?)\n\s*\*\s*---/);
  if (!fmMatch) { return info; }

  // Strip leading " * " from each line
  const yaml = fmMatch[1]
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, ""))
    .join("\n");

  // Extract description
  const descMatch = yaml.match(/^description:\s*"(.+?)"\s*$/m);
  if (descMatch) { info.description = descMatch[1]; }

  // Extract parameters block
  const paramsIdx = yaml.indexOf("  parameters:");
  if (paramsIdx === -1) { return info; }

  const paramsBlock = yaml.slice(paramsIdx + "  parameters:".length);

  // Each parameter starts with "  - name:"
  const paramRegex = /- name:\s*(\S+)([\s\S]*?)(?=\n\s*- name:|\n\s*\w+:|$)/g;
  let match: RegExpExecArray | null;

  while ((match = paramRegex.exec(paramsBlock)) !== null) {
    const paramName = match[1];
    const body = match[2];

    const typeMatch = body.match(/type:\s*(\S+)/);
    const requiredMatch = body.match(/required:\s*(true|false)/);
    const defaultMatch = body.match(/default:\s*"?([^"\n]+)"?/);
    const descM = body.match(/description:\s*"(.+?)"/);

    info.params.push({
      name: paramName,
      type: typeMatch?.[1] ?? "string",
      required: requiredMatch ? requiredMatch[1] === "true" : true,
      default: defaultMatch?.[1]?.trim(),
      description: descM?.[1],
    });
  }

  return info;
}

/** Show the Run Flow panel. If the flow has no params, runs immediately in terminal. */
export function showRunFlowPanel(flowInfo: FlowInfo): void {
  if (flowInfo.params.length === 0) {
    // No parameters — run directly
    runInTerminal(flowInfo.name, flowInfo.path, []);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "modiqo.runFlow",
    `Run: ${flowInfo.name}`,
    vscode.ViewColumn.One,
    { enableScripts: true }
  );

  panel.webview.html = buildRunFlowHtml(flowInfo);

  panel.webview.onDidReceiveMessage((msg) => {
    if (msg.type === "run") {
      const args: string[] = msg.args;
      panel.dispose();
      runInTerminal(flowInfo.name, flowInfo.path, args);
    } else if (msg.type === "cancel") {
      panel.dispose();
    }
  });
}

function runInTerminal(name: string, flowPath: string, args: string[]): void {
  const terminal = vscode.window.createTerminal({ name: `dex: ${name}` });
  terminal.show();
  const quotedArgs = args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");
  const cmd = quotedArgs
    ? `dex deno run --allow-all "${flowPath}" ${quotedArgs}`
    : `dex deno run --allow-all "${flowPath}"`;
  terminal.sendText(cmd);
}

function buildRunFlowHtml(flow: FlowInfo): string {
  const fields = flow.params
    .map((p, i) => {
      const inputType = p.type === "number" ? "number" : "text";
      const placeholder = p.default ?? (p.required ? "required" : "optional");
      const defaultVal = p.default ?? "";
      return `
        <div class="field" data-index="${i}">
          <div class="field-header">
            <label for="param-${i}">${p.name}${p.required ? '<span class="req">*</span>' : ""}</label>
            <span class="type-badge">${p.type}</span>
          </div>
          ${p.description ? `<div class="field-desc">${escHtml(p.description)}</div>` : ""}
          <input
            id="param-${i}"
            type="${inputType}"
            placeholder="${escHtml(placeholder)}"
            value="${escHtml(defaultVal)}"
            data-required="${p.required}"
            data-name="${escHtml(p.name)}"
            autocomplete="off"
          />
          <div class="validation-msg"></div>
        </div>`;
    })
    .join("\n");

  const descHtml = flow.description
    ? `<p class="flow-desc">${escHtml(flow.description)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root {
    --fg: var(--vscode-foreground);
    --fg-dim: var(--vscode-descriptionForeground);
    --bg: var(--vscode-editor-background);
    --border: var(--vscode-panel-border, #3c3c3c);
    --accent: var(--vscode-button-background, #0e639c);
    --accent-fg: var(--vscode-button-foreground, #fff);
    --card-bg: var(--vscode-sideBar-background, #1e1e1e);
    --input-bg: var(--vscode-input-background, #3c3c3c);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, #555);
    --error: var(--vscode-inputValidation-errorBorder, #f44747);
    --mono: var(--vscode-editor-font-family, monospace);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--fg);
    background: var(--bg);
    padding: 28px 32px 40px;
    max-width: 680px;
  }
  .header { margin-bottom: 20px; }
  .flow-name {
    font-size: 1.25em;
    font-weight: 700;
    margin-bottom: 6px;
  }
  .flow-desc {
    font-size: 0.84em;
    color: var(--fg-dim);
    line-height: 1.5;
    margin-bottom: 20px;
  }
  .divider {
    border: none;
    border-top: 1px solid var(--border);
    margin: 20px 0;
  }
  .section-title {
    font-size: 0.68em;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--fg-dim);
    margin-bottom: 16px;
  }
  .fields { display: flex; flex-direction: column; gap: 18px; }
  .field {}
  .field-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 5px;
  }
  label {
    font-size: 0.9em;
    font-weight: 600;
  }
  .req { color: var(--error); margin-left: 2px; }
  .type-badge {
    font-size: 0.68em;
    font-family: var(--mono);
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 6px;
    color: var(--fg-dim);
  }
  .field-desc {
    font-size: 0.78em;
    color: var(--fg-dim);
    margin-bottom: 6px;
    line-height: 1.4;
  }
  input {
    width: 100%;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: 4px;
    padding: 7px 10px;
    font-size: 0.9em;
    font-family: inherit;
    outline: none;
    transition: border-color 0.15s;
  }
  input:focus { border-color: var(--accent); }
  input.error { border-color: var(--error); }
  .validation-msg {
    font-size: 0.75em;
    color: var(--error);
    margin-top: 4px;
    display: none;
  }
  .validation-msg.visible { display: block; }
  .actions {
    display: flex;
    gap: 10px;
    margin-top: 28px;
  }
  button {
    padding: 8px 20px;
    border-radius: 4px;
    border: none;
    font-size: 0.9em;
    cursor: pointer;
    font-family: inherit;
    font-weight: 500;
  }
  .btn-run {
    background: var(--accent);
    color: var(--accent-fg);
  }
  .btn-run:hover { opacity: 0.9; }
  .btn-cancel {
    background: transparent;
    color: var(--fg-dim);
    border: 1px solid var(--border);
  }
  .btn-cancel:hover { color: var(--fg); border-color: var(--fg-dim); }
  .cmd-preview {
    margin-top: 20px;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px 14px;
  }
  .cmd-preview-label {
    font-size: 0.68em;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--fg-dim);
    margin-bottom: 6px;
  }
  .cmd-preview-text {
    font-family: var(--mono);
    font-size: 0.8em;
    color: var(--fg);
    word-break: break-all;
    white-space: pre-wrap;
  }
</style>
</head>
<body>
<div class="header">
  <div class="flow-name">${escHtml(flow.name)}</div>
  ${descHtml}
</div>

<hr class="divider">
<div class="section-title">Parameters</div>

<div class="fields">
${fields}
</div>

<div class="actions">
  <button class="btn-run" onclick="submit()">Run Flow</button>
  <button class="btn-cancel" onclick="cancel()">Cancel</button>
</div>

<div class="cmd-preview">
  <div class="cmd-preview-label">Command preview</div>
  <div class="cmd-preview-text" id="preview">dex deno run --allow-all "${escHtml(flow.path)}"</div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  const flowPath = ${JSON.stringify(flow.path)};

  function getInputs() {
    return Array.from(document.querySelectorAll('input[data-name]'));
  }

  function buildArgs() {
    return getInputs().map(inp => inp.value.trim());
  }

  function updatePreview() {
    const args = buildArgs().filter(Boolean);
    const quotedArgs = args.map(a => a.includes(' ') ? '"' + a + '"' : a).join(' ');
    const cmd = quotedArgs
      ? 'dex deno run --allow-all "' + flowPath + '" ' + quotedArgs
      : 'dex deno run --allow-all "' + flowPath + '"';
    document.getElementById('preview').textContent = cmd;
  }

  getInputs().forEach(inp => inp.addEventListener('input', updatePreview));
  updatePreview();

  function submit() {
    let valid = true;
    getInputs().forEach((inp, i) => {
      const required = inp.dataset.required === 'true';
      const msg = inp.parentElement.querySelector('.validation-msg');
      if (required && !inp.value.trim()) {
        inp.classList.add('error');
        if (msg) { msg.textContent = inp.dataset.name + ' is required'; msg.classList.add('visible'); }
        valid = false;
      } else {
        inp.classList.remove('error');
        if (msg) { msg.classList.remove('visible'); }
      }
    });
    if (!valid) return;
    vscode.postMessage({ type: 'run', args: buildArgs() });
  }

  function cancel() {
    vscode.postMessage({ type: 'cancel' });
  }

  // Enter key on last field submits
  getInputs().forEach(inp => {
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  });
</script>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
