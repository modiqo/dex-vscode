import * as vscode from "vscode";
import { DexClient } from "../client/dexClient";

export async function showReferencePanel(
  client: DexClient,
  args: string[]
): Promise<void> {
  const title = `dex ${args.join(" ")}`;

  const panel = vscode.window.createWebviewPanel(
    "modiqo.reference",
    title,
    vscode.ViewColumn.One,
    { enableScripts: false }
  );

  // Show loading state
  panel.webview.html = buildHtml(title, "Loading...");

  try {
    const output = await client.execText(args);
    panel.webview.html = buildHtml(title, output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    panel.webview.html = buildHtml(title, `Error: ${msg}`);
  }
}

function buildHtml(title: string, content: string): string {
  const escaped = escapeHtml(content);

  // Convert ANSI-style formatting to styled spans
  const rendered = escaped
    // Section headers: === TITLE ===
    .replace(
      /^(=== .+ ===)$/gm,
      '<div class="section-header">$1</div>'
    )
    // Sub-headers: --- Title ---
    .replace(
      /^(--- .+ ---)$/gm,
      '<div class="sub-header">$1</div>'
    )
    // Headings: # and ##
    .replace(
      /^(#{1,3}) (.+)$/gm,
      (_, hashes, text) => {
        const level = hashes.length;
        return `<h${level} class="md-heading">${text}</h${level}>`;
      }
    )
    // Command examples: lines starting with "  dex:" or "  dex "
    .replace(
      /^(  dex: .+)$/gm,
      '<span class="cmd">$1</span>'
    )
    // Code blocks: ```...```
    .replace(
      /```(\w*)\n([\s\S]*?)```/g,
      '<pre class="code-block">$2</pre>'
    )
    // Inline code: `...`
    .replace(
      /`([^`]+)`/g,
      '<code class="inline-code">$1</code>'
    )
    // Bullet markers: ▸
    .replace(
      /▸ (.+)/g,
      '<span class="bullet">▸</span> <span class="bullet-text">$1</span>'
    )
    // Equivalence: ≈
    .replace(
      /≈ (.+)/g,
      '<span class="equiv">≈ $1</span>'
    )
    // Result arrows: →
    .replace(
      /→ (.+)/g,
      '<span class="result">→ $1</span>'
    )
    // Bold: **text**
    .replace(
      /\*\*([^*]+)\*\*/g,
      '<strong>$1</strong>'
    )
    // Blockquotes: > text
    .replace(
      /^&gt; (.+)$/gm,
      '<blockquote>$1</blockquote>'
    );

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
    --card-bg: var(--vscode-editorWidget-background, var(--bg));
    --success: #4ec9b0;
    --orange: #E87A2A;
    --mono: var(--vscode-editor-font-family, 'SF Mono', 'Fira Code', monospace);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--fg);
    background: var(--bg);
    padding: 24px 32px;
    line-height: 1.6;
  }

  .title {
    font-size: 1.1em;
    font-weight: 600;
    color: var(--accent);
    margin-bottom: 20px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }

  .content {
    white-space: pre-wrap;
    word-wrap: break-word;
  }

  .section-header {
    font-weight: 700;
    font-size: 1.05em;
    color: var(--fg);
    margin: 20px 0 8px 0;
    padding: 6px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
  }

  .sub-header {
    font-weight: 600;
    color: var(--fg);
    margin: 16px 0 6px 0;
    opacity: 0.85;
  }

  .md-heading {
    margin: 18px 0 8px 0;
    color: var(--fg);
  }
  h1.md-heading { font-size: 1.2em; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  h2.md-heading { font-size: 1.05em; }
  h3.md-heading { font-size: 0.95em; }

  .cmd {
    color: var(--success);
    display: block;
  }

  .code-block {
    background: color-mix(in srgb, var(--border) 15%, transparent);
    border: 1px solid color-mix(in srgb, var(--border) 30%, transparent);
    border-radius: 6px;
    padding: 10px 14px;
    margin: 8px 0;
    overflow-x: auto;
    font-size: 12px;
  }

  .inline-code {
    background: color-mix(in srgb, var(--border) 20%, transparent);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 0.95em;
  }

  .bullet { color: var(--orange); font-weight: 600; }
  .bullet-text { font-weight: 500; }

  .equiv { color: var(--fg-dim); font-style: italic; display: block; }

  .result { color: var(--accent); display: block; }

  blockquote {
    border-left: 3px solid var(--accent);
    padding: 4px 12px;
    margin: 8px 0;
    color: var(--fg-dim);
  }

  strong { color: var(--fg); }
</style>
</head>
<body>
  <div class="title">${escapeHtml(title)}</div>
  <div class="content">${rendered}</div>
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
