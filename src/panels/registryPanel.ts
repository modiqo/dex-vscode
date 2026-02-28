import * as vscode from "vscode";
import type {
  RegistryAdapter,
  RegistrySkill,
} from "../client/dexClient";

export function showRegistryDetailPanel(
  extensionUri: vscode.Uri,
  item: RegistryAdapter | RegistrySkill,
  kind: "adapter" | "skill",
  allAdapters: RegistryAdapter[],
  allSkills: RegistrySkill[]
): void {
  const title =
    kind === "adapter"
      ? `Adapter: ${(item as RegistryAdapter).name}`
      : `Flow: ${(item as RegistrySkill).name}`;

  const panel = vscode.window.createWebviewPanel(
    "modiqo.registryDetail",
    title,
    vscode.ViewColumn.One,
    { enableScripts: true }
  );

  if (kind === "adapter") {
    panel.webview.html = buildAdapterDetailHtml(
      item as RegistryAdapter,
      allSkills
    );
  } else {
    panel.webview.html = buildSkillDetailHtml(
      item as RegistrySkill,
      allAdapters
    );
  }
}

export function showRegistryOverviewPanel(
  extensionUri: vscode.Uri,
  adapters: RegistryAdapter[],
  skills: RegistrySkill[]
): void {
  const panel = vscode.window.createWebviewPanel(
    "modiqo.registryOverview",
    "Registry: bootstrap",
    vscode.ViewColumn.One,
    { enableScripts: true }
  );

  panel.webview.html = buildOverviewHtml(adapters, skills);
}

// ── Overview: adapter + skill graph ─────────────────────────────────

function buildOverviewHtml(
  adapters: RegistryAdapter[],
  skills: RegistrySkill[]
): string {
  const adaptersJson = JSON.stringify(adapters);
  const skillsJson = JSON.stringify(skills);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  ${sharedCss()}

  .grid-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
  }

  .grid-header h2 {
    font-size: 1.1em;
    font-weight: 600;
  }

  .grid-header .count {
    font-size: 0.8em;
    color: var(--fg-dim);
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 2px 10px;
  }

  /* Fingerprint graph */
  .graph-container {
    margin: 32px 0;
    padding: 24px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card-bg);
  }

  .graph-title {
    font-size: 0.9em;
    font-weight: 600;
    margin-bottom: 16px;
  }

  .graph-subtitle {
    font-size: 0.75em;
    color: var(--fg-dim);
    margin-bottom: 20px;
  }

  /* Adapter-Skill relationship grid */
  .relation-grid {
    display: grid;
    gap: 2px;
  }

  .relation-row {
    display: flex;
    align-items: stretch;
    gap: 2px;
  }

  .relation-label {
    width: 160px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    padding: 6px 12px;
    font-size: 0.78em;
    font-weight: 500;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-radius: 4px 0 0 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .relation-cells {
    display: flex;
    gap: 2px;
    flex: 1;
  }

  .relation-cell {
    flex: 1;
    min-width: 0;
    height: 32px;
    border-radius: 3px;
    cursor: pointer;
    transition: filter 0.15s, transform 0.1s;
    position: relative;
  }

  .relation-cell:hover {
    filter: brightness(1.3);
    transform: scaleY(1.1);
    z-index: 2;
  }

  .cell-active {
    background: var(--accent);
    opacity: 0.8;
  }

  .cell-inactive {
    background: var(--border);
    opacity: 0.3;
  }

  .col-headers {
    display: flex;
    gap: 2px;
    margin-left: 162px;
    margin-bottom: 6px;
  }

  .col-header {
    flex: 1;
    min-width: 0;
    font-size: 0.62em;
    color: var(--fg-dim);
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transform: rotate(-35deg);
    transform-origin: bottom left;
    height: 60px;
    display: flex;
    align-items: flex-end;
    justify-content: flex-start;
    padding-left: 4px;
  }

  /* Cards grid */
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
    margin-bottom: 32px;
  }

  .card {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    background: var(--card-bg);
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }

  .card:hover {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 5%, var(--card-bg));
  }

  .card-name {
    font-size: 0.95em;
    font-weight: 600;
    margin-bottom: 4px;
  }

  .card-fingerprint {
    font-size: 0.72em;
    font-family: var(--mono);
    color: var(--accent);
    margin-bottom: 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card-desc {
    font-size: 0.82em;
    color: var(--fg-dim);
    line-height: 1.5;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .card-adapters {
    font-size: 0.72em;
    margin-top: 8px;
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }

  .adapter-tag {
    padding: 2px 8px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--accent);
    font-size: 0.9em;
  }

  .visibility-badge {
    font-size: 0.68em;
    padding: 1px 6px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--success) 15%, transparent);
    color: var(--success);
    margin-left: 8px;
    vertical-align: middle;
  }

  /* Tooltip */
  .tooltip {
    display: none;
    position: fixed;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px 16px;
    font-size: 0.85em;
    pointer-events: none;
    z-index: 100;
    box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    min-width: 220px;
    max-width: 380px;
  }
  .tooltip .tt-title { font-weight: 600; margin-bottom: 6px; }
  .tooltip .tt-row { color: var(--fg-dim); margin: 3px 0; font-size: 0.9em; }
  .tooltip .tt-row span { color: var(--fg); }
  .tooltip .tt-fp { font-family: var(--mono); font-size: 0.8em; color: var(--accent); margin: 4px 0; }
</style>
</head>
<body>
  <div class="header">
    <h1>Registry</h1>
    <div class="subtitle">bootstrap community</div>
  </div>

  <!-- Relationship graph -->
  <div class="graph-container">
    <div class="graph-title">Flow-Adapter Fingerprint Map</div>
    <div class="graph-subtitle">Each cell shows whether a flow binds to an adapter via fingerprint matching. Hover to see details.</div>
    <div id="col-headers" class="col-headers"></div>
    <div id="relation-grid" class="relation-grid"></div>
  </div>

  <!-- Adapters -->
  <div class="grid-header">
    <h2>Adapters</h2>
    <span class="count" id="adapter-count"></span>
  </div>
  <div class="cards" id="adapter-cards"></div>

  <!-- Skills -->
  <div class="grid-header">
    <h2>Flows</h2>
    <span class="count" id="skill-count"></span>
  </div>
  <div class="cards" id="skill-cards"></div>

  <div class="tooltip" id="tooltip"></div>

  <footer>modiqo &middot; registry</footer>

  <script>
    const adapters = ${adaptersJson};
    const skills = ${skillsJson};
    const tooltip = document.getElementById('tooltip');

    document.getElementById('adapter-count').textContent = adapters.length + ' adapters';
    document.getElementById('skill-count').textContent = skills.length + ' flows';

    // ── Build relationship grid ──────────────────────────────────
    // Skills as rows, adapters as columns
    const gridEl = document.getElementById('relation-grid');
    const colHeadersEl = document.getElementById('col-headers');

    // Column headers (adapters)
    adapters.forEach(a => {
      const col = document.createElement('div');
      col.className = 'col-header';
      col.textContent = a.name;
      colHeadersEl.appendChild(col);
    });

    // Build a lookup: which adapter names does each skill reference
    function skillMatchesAdapter(skill, adapterName) {
      const adaptersField = (skill.adapters || '').toLowerCase();
      const name = adapterName.toLowerCase();
      // Handle truncated names like "gemini-…" or "elevenl…" or "paralle…"
      if (adaptersField.includes(name)) return true;
      // Check if adapter name starts with the truncated adapter field
      if (adaptersField.endsWith('\u2026') || adaptersField.endsWith('...')) {
        const prefix = adaptersField.replace(/[\u2026.]+$/, '').trim();
        if (name.startsWith(prefix)) return true;
      }
      // Check multi-adapter fields (comma separated)
      const parts = adaptersField.split(/[,;]\\s*/);
      for (const part of parts) {
        const clean = part.replace(/[\\u2026.]+$/, '').trim();
        if (clean && name.startsWith(clean)) return true;
        if (name === clean) return true;
      }
      return false;
    }

    skills.forEach(skill => {
      const row = document.createElement('div');
      row.className = 'relation-row';

      const label = document.createElement('div');
      label.className = 'relation-label';
      label.textContent = skill.name;
      label.title = skill.name;
      row.appendChild(label);

      const cells = document.createElement('div');
      cells.className = 'relation-cells';

      adapters.forEach(adapter => {
        const cell = document.createElement('div');
        const matches = skillMatchesAdapter(skill, adapter.name);
        cell.className = 'relation-cell ' + (matches ? 'cell-active' : 'cell-inactive');

        cell.addEventListener('mousemove', e => {
          tooltip.style.display = 'block';
          tooltip.style.left = Math.min(e.clientX + 14, window.innerWidth - 400) + 'px';
          tooltip.style.top = (e.clientY - 10) + 'px';
          tooltip.innerHTML =
            '<div class="tt-title">' + escapeHtml(skill.name) + '</div>' +
            '<div class="tt-row">Adapter: <span>' + escapeHtml(adapter.name) + '</span></div>' +
            '<div class="tt-fp">' + escapeHtml(adapter.fingerprint) + '</div>' +
            '<div class="tt-row">' + (matches ? 'Bound via fingerprint' : 'No binding') + '</div>';
        });

        cell.addEventListener('mouseout', () => { tooltip.style.display = 'none'; });

        cells.appendChild(cell);
      });

      row.appendChild(cells);
      gridEl.appendChild(row);
    });

    // ── Adapter cards ────────────────────────────────────────────
    const adapterCards = document.getElementById('adapter-cards');
    adapters.forEach(a => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<div class="card-name">' + escapeHtml(a.name) +
        '<span class="visibility-badge">' + escapeHtml(a.visibility) + '</span></div>' +
        '<div class="card-fingerprint">' + escapeHtml(a.fingerprint) + '</div>' +
        '<div class="card-desc">' + escapeHtml(a.description) + '</div>';
      adapterCards.appendChild(card);
    });

    // ── Skill cards ──────────────────────────────────────────────
    const skillCards = document.getElementById('skill-cards');
    skills.forEach(s => {
      const adapterNames = (s.adapters || '').split(/[,;]\\s*/).filter(Boolean);
      const tags = adapterNames.map(n => '<span class="adapter-tag">' + escapeHtml(n) + '</span>').join('');

      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<div class="card-name">' + escapeHtml(s.name) +
        '<span class="visibility-badge">' + escapeHtml(s.visibility) + '</span></div>' +
        '<div class="card-desc">' + escapeHtml(s.description) + '</div>' +
        '<div class="card-adapters">' + tags + '</div>';
      skillCards.appendChild(card);
    });

    function escapeHtml(s) {
      if (!s) return '';
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  </script>
</body>
</html>`;
}

// ── Adapter detail ──────────────────────────────────────────────────

function buildAdapterDetailHtml(
  adapter: RegistryAdapter,
  allSkills: RegistrySkill[]
): string {
  // Find skills that reference this adapter
  const matchingSkills = allSkills.filter((s) => {
    const adaptersField = (s.adapters || "").toLowerCase();
    const name = adapter.name.toLowerCase();
    if (adaptersField.includes(name)) { return true; }
    const parts = adaptersField.split(/[,;]\s*/);
    return parts.some((p) => {
      const clean = p.replace(/[\u2026.]+$/, "").trim();
      return clean && name.startsWith(clean);
    });
  });

  const skillListHtml = matchingSkills.length > 0
    ? matchingSkills
        .map(
          (s) =>
            `<div class="linked-item">
              <div class="linked-name">${escapeHtml(s.name)}</div>
              <div class="linked-desc">${escapeHtml(s.description)}</div>
            </div>`
        )
        .join("")
    : '<div class="empty-state">No flows bound to this adapter</div>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  ${sharedCss()}

  .detail-card {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 20px 24px;
    background: var(--card-bg);
    margin-bottom: 20px;
  }

  .detail-card h3 {
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--fg-dim);
    margin-bottom: 12px;
  }

  .field-row {
    display: flex;
    padding: 6px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
    font-size: 0.88em;
  }

  .field-row:last-child { border-bottom: none; }

  .field-label {
    width: 120px;
    flex-shrink: 0;
    color: var(--fg-dim);
  }

  .field-value {
    flex: 1;
    font-family: var(--mono);
  }

  .fingerprint-badge {
    display: inline-block;
    padding: 4px 12px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--accent);
    border-radius: 4px;
    font-family: var(--mono);
    font-size: 0.9em;
    letter-spacing: 0.02em;
  }

  .linked-item {
    padding: 10px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
  }

  .linked-item:last-child { border-bottom: none; }

  .linked-name {
    font-weight: 500;
    font-size: 0.9em;
    margin-bottom: 2px;
  }

  .linked-desc {
    font-size: 0.8em;
    color: var(--fg-dim);
    line-height: 1.4;
  }

  .empty-state {
    color: var(--fg-dim);
    font-size: 0.85em;
    padding: 12px 0;
  }

  .install-cmd {
    margin-top: 16px;
    padding: 12px 16px;
    background: color-mix(in srgb, var(--bg) 80%, var(--border));
    border: 1px solid var(--border);
    border-radius: 6px;
    font-family: var(--mono);
    font-size: 0.85em;
    color: var(--accent);
  }
</style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(adapter.name)}</h1>
    <div class="subtitle">${escapeHtml(adapter.description)}</div>
  </div>

  <div class="detail-card">
    <h3>Specification</h3>
    <div class="field-row">
      <div class="field-label">Fingerprint</div>
      <div class="field-value"><span class="fingerprint-badge">${escapeHtml(adapter.fingerprint)}</span></div>
    </div>
    <div class="field-row">
      <div class="field-label">Visibility</div>
      <div class="field-value">${escapeHtml(adapter.visibility)}</div>
    </div>
  </div>

  <div class="detail-card">
    <h3>Bound Flows (${matchingSkills.length})</h3>
    ${skillListHtml}
  </div>

  <div class="install-cmd">dex registry adapter pull bootstrap/${escapeHtml(adapter.name)}</div>

  <footer>modiqo &middot; registry</footer>
</body>
</html>`;
}

// ── Skill detail ────────────────────────────────────────────────────

function buildSkillDetailHtml(
  skill: RegistrySkill,
  allAdapters: RegistryAdapter[]
): string {
  // Find matching adapters for this skill
  const adapterNames = (skill.adapters || "")
    .split(/[,;]\s*/)
    .map((n) => n.replace(/[\u2026.]+$/, "").trim())
    .filter(Boolean);

  const matchingAdapters = allAdapters.filter((a) =>
    adapterNames.some((prefix) =>
      a.name.toLowerCase().startsWith(prefix.toLowerCase())
    )
  );

  const adapterListHtml = matchingAdapters.length > 0
    ? matchingAdapters
        .map(
          (a) =>
            `<div class="linked-item">
              <div class="linked-name">${escapeHtml(a.name)}</div>
              <div class="linked-desc">
                <span class="fingerprint-badge">${escapeHtml(a.fingerprint)}</span>
              </div>
            </div>`
        )
        .join("")
    : '<div class="empty-state">No adapter bindings resolved</div>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  ${sharedCss()}

  .detail-card {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 20px 24px;
    background: var(--card-bg);
    margin-bottom: 20px;
  }

  .detail-card h3 {
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--fg-dim);
    margin-bottom: 12px;
  }

  .field-row {
    display: flex;
    padding: 6px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
    font-size: 0.88em;
  }

  .field-row:last-child { border-bottom: none; }

  .field-label {
    width: 120px;
    flex-shrink: 0;
    color: var(--fg-dim);
  }

  .field-value {
    flex: 1;
  }

  .fingerprint-badge {
    display: inline-block;
    padding: 4px 12px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--accent);
    border-radius: 4px;
    font-family: var(--mono);
    font-size: 0.85em;
  }

  .linked-item {
    padding: 10px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
  }

  .linked-item:last-child { border-bottom: none; }

  .linked-name {
    font-weight: 500;
    font-size: 0.9em;
    margin-bottom: 4px;
  }

  .linked-desc {
    font-size: 0.8em;
    color: var(--fg-dim);
    line-height: 1.4;
  }

  .empty-state {
    color: var(--fg-dim);
    font-size: 0.85em;
    padding: 12px 0;
  }

  .install-cmd {
    margin-top: 16px;
    padding: 12px 16px;
    background: color-mix(in srgb, var(--bg) 80%, var(--border));
    border: 1px solid var(--border);
    border-radius: 6px;
    font-family: var(--mono);
    font-size: 0.85em;
    color: var(--accent);
  }
</style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(skill.name)}</h1>
    <div class="subtitle">${escapeHtml(skill.description)}</div>
  </div>

  <div class="detail-card">
    <h3>Details</h3>
    <div class="field-row">
      <div class="field-label">Adapters</div>
      <div class="field-value">${escapeHtml(skill.adapters)}</div>
    </div>
    <div class="field-row">
      <div class="field-label">Visibility</div>
      <div class="field-value">${escapeHtml(skill.visibility)}</div>
    </div>
  </div>

  <div class="detail-card">
    <h3>Adapter Bindings (${matchingAdapters.length})</h3>
    ${adapterListHtml}
  </div>

  <div class="install-cmd">dex registry skill pull bootstrap/${escapeHtml(skill.name)}</div>

  <footer>modiqo &middot; registry</footer>
</body>
</html>`;
}

// ── Shared CSS ──────────────────────────────────────────────────────

function sharedCss(): string {
  return `
  :root {
    --fg: var(--vscode-foreground);
    --fg-dim: var(--vscode-descriptionForeground);
    --bg: var(--vscode-editor-background);
    --border: var(--vscode-widget-border, #333);
    --accent: var(--vscode-textLink-foreground);
    --card-bg: var(--vscode-editorWidget-background, var(--bg));
    --success: #4ec9b0;
    --error: #f14c4c;
    --mono: var(--vscode-editor-font-family, 'SF Mono', 'Fira Code', monospace);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--fg);
    background: var(--bg);
    padding: 24px 32px;
    line-height: 1.5;
  }

  .header { margin-bottom: 24px; }
  .header h1 { font-size: 1.4em; font-weight: 600; }
  .header .subtitle { color: var(--fg-dim); font-size: 0.9em; margin-top: 4px; }

  footer {
    margin-top: 28px;
    font-size: 0.72em;
    color: var(--fg-dim);
  }
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
