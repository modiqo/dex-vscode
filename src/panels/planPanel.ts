import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

interface WorkspaceInfo {
  name: string;
  dir: string;
}

interface PlanNode {
  responseId: number;
  toolName: string;
  endpoint: string;
  durationMs: number;
  hasError: boolean;
  isInit: boolean;
  dependencies: number[];
}

interface ExecutionLevel {
  level: number;
  nodes: PlanNode[];
  maxDurationMs: number;
}

interface PlanData {
  nodes: PlanNode[];
  levels: ExecutionLevel[];
  totalSequentialMs: number;
  totalParallelMs: number;
  speedup: number;
  duplicates: Array<{ toolName: string; count: number; wastedMs: number }>;
  edges: Array<{ from: number; to: number }>;
}

export function showPlanPanel(
  extensionUri: vscode.Uri,
  ws: WorkspaceInfo
): void {
  const stateFile = path.join(ws.dir, ".dex", "state.json");
  if (!fs.existsSync(stateFile)) {
    vscode.window.showWarningMessage("No state.json found for this workspace.");
    return;
  }

  const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  const plan = buildPlanData(ws.dir, state);

  if (plan.nodes.length === 0) {
    vscode.window.showInformationMessage("No execution data available for plan.");
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "modiqo.plan",
    `Plan: ${ws.name}`,
    vscode.ViewColumn.One,
    { enableScripts: true }
  );

  panel.webview.html = buildPlanHtml(ws.name, plan);
}

function buildPlanData(
  wsDir: string,
  state: {
    command_log: Array<{
      sequence: number;
      type: { command: string; params: Record<string, unknown> };
      response_ids: number[];
      dependencies: Array<{
        source_response: number;
        variable_name?: string;
        dependency_type?: string;
      }>;
    }>;
    named_vars?: Record<string, string>;
  }
): PlanData {
  const commandLog = state.command_log || [];
  const nodes: PlanNode[] = [];
  const nodeMap = new Map<number, PlanNode>();

  const initEndpoints = new Map<string, number>();
  const prevByEndpoint = new Map<string, number>();

  for (const cmd of commandLog) {
    if (cmd.type.command !== "HttpRequest" || cmd.response_ids.length === 0) {
      continue;
    }

    const rid = cmd.response_ids[0];
    const params = cmd.type.params;
    const endpoint = (params.endpoint as string) || "";
    const body = params.body as Record<string, unknown> | undefined;
    const method = (body?.method as string) ?? "request";
    const toolParams = body?.params as Record<string, unknown> | undefined;
    const toolName = (toolParams?.name as string) ?? method;
    const isInit = method === "initialize";

    const responseFile = path.join(wsDir, ".dex", "responses", `@${rid}.json`);
    let durationMs = 0;
    let hasError = false;

    if (fs.existsSync(responseFile)) {
      try {
        const resp = JSON.parse(fs.readFileSync(responseFile, "utf-8"));
        durationMs = resp.response?.duration_ms ?? 0;
        hasError = (resp.response?.status ?? 200) >= 400;
      } catch { /* skip */ }
    }

    const node: PlanNode = {
      responseId: rid, toolName, endpoint, durationMs, hasError, isInit,
      dependencies: [],
    };

    if (isInit) {
      initEndpoints.set(endpoint, rid);
    } else if (initEndpoints.has(endpoint)) {
      const initRid = initEndpoints.get(endpoint)!;
      if (!node.dependencies.includes(initRid)) {
        node.dependencies.push(initRid);
      }
    }

    if (endpoint.startsWith("stdio:")) {
      const prev = prevByEndpoint.get(endpoint);
      if (prev !== undefined && !node.dependencies.includes(prev)) {
        node.dependencies.push(prev);
      }
    }

    prevByEndpoint.set(endpoint, rid);
    nodes.push(node);
    nodeMap.set(rid, node);
  }

  // Stored dependencies
  for (const cmd of commandLog) {
    if (cmd.response_ids.length === 0) { continue; }
    for (const dep of (cmd.dependencies || [])) {
      if (dep.source_response > 0 && nodeMap.has(dep.source_response)) {
        for (const rid of cmd.response_ids) {
          const node = nodeMap.get(rid);
          if (node && !node.dependencies.includes(dep.source_response)) {
            node.dependencies.push(dep.source_response);
          }
        }
      }
    }
  }

  // Value-based inference
  const responseBodyCache = new Map<number, string>();
  function getResponseBody(rid: number): string {
    if (responseBodyCache.has(rid)) { return responseBodyCache.get(rid)!; }
    const file = path.join(wsDir, ".dex", "responses", `@${rid}.json`);
    let body = "";
    if (fs.existsSync(file)) {
      try { body = fs.readFileSync(file, "utf-8"); } catch { /* skip */ }
    }
    responseBodyCache.set(rid, body);
    return body;
  }

  function extractMatchableValues(jsonStr: string): Set<string> {
    const values = new Set<string>();
    const pattern = /(?:\\"|")([a-zA-Z0-9_-]{10,})(?:\\"|")/g;
    let match;
    while ((match = pattern.exec(jsonStr)) !== null) {
      const val = match[1];
      if (val !== val.toLowerCase()) { values.add(val); }
    }
    return values;
  }

  for (let i = 0; i < commandLog.length; i++) {
    const cmd = commandLog[i];
    if (cmd.type.command !== "QueryRead") { continue; }
    const sourceRid = (cmd.type.params.source_response as number) ?? 0;
    if (sourceRid === 0 || !nodeMap.has(sourceRid)) { continue; }

    for (let j = i + 1; j < commandLog.length; j++) {
      if (commandLog[j].type.command !== "HttpRequest") { continue; }
      if (commandLog[j].response_ids.length === 0) { continue; }
      const nextRid = commandLog[j].response_ids[0];
      const nextNode = nodeMap.get(nextRid);
      if (!nextNode || nextNode.isInit) { break; }

      const sourceBody = getResponseBody(sourceRid);
      const nextResponseFile = path.join(wsDir, ".dex", "responses", `@${nextRid}.json`);
      let requestBodyStr = "";
      if (fs.existsSync(nextResponseFile)) {
        try {
          const data = JSON.parse(fs.readFileSync(nextResponseFile, "utf-8"));
          requestBodyStr = JSON.stringify(data.request?.body || {});
        } catch { /* skip */ }
      }

      if (sourceBody && requestBodyStr) {
        const sourceVals = extractMatchableValues(sourceBody);
        const hasDataFlow = [...sourceVals].some(val => requestBodyStr.includes(val));
        if (hasDataFlow && !nextNode.dependencies.includes(sourceRid)) {
          nextNode.dependencies.push(sourceRid);
        }
      }
      break;
    }
  }

  const levels = topoSortLevels(nodes, nodeMap);
  const totalSequentialMs = nodes.reduce((s, n) => s + n.durationMs, 0);
  const totalParallelMs = levels.reduce((s, l) => s + l.maxDurationMs, 0);
  const speedup = totalParallelMs > 0 ? totalSequentialMs / totalParallelMs : 1;

  // Duplicates
  const fingerprints = new Map<string, { toolName: string; rids: number[]; durations: number[] }>();
  for (const node of nodes) {
    if (node.isInit) { continue; }
    const responseFile = path.join(wsDir, ".dex", "responses", `@${node.responseId}.json`);
    if (fs.existsSync(responseFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(responseFile, "utf-8"));
        const bodyStr = JSON.stringify(data.request?.body || {});
        const fp = `${data.request?.url}::${bodyStr}`;
        const entry = fingerprints.get(fp) || { toolName: node.toolName, rids: [], durations: [] };
        entry.rids.push(node.responseId);
        entry.durations.push(node.durationMs);
        fingerprints.set(fp, entry);
      } catch { /* skip */ }
    }
  }

  const duplicates = [...fingerprints.values()]
    .filter(e => e.rids.length > 1)
    .map(e => ({
      toolName: e.toolName,
      count: e.rids.length,
      wastedMs: e.durations.slice(1).reduce((s, d) => s + d, 0),
    }));

  const edges: Array<{ from: number; to: number }> = [];
  const nodeIdSet = new Set(nodes.map(n => n.responseId));
  for (const node of nodes) {
    for (const dep of node.dependencies) {
      if (nodeIdSet.has(dep)) {
        edges.push({ from: dep, to: node.responseId });
      }
    }
  }

  return { nodes, levels, totalSequentialMs, totalParallelMs, speedup, duplicates, edges };
}

function topoSortLevels(nodes: PlanNode[], nodeMap: Map<number, PlanNode>): ExecutionLevel[] {
  const nodeIds = new Set(nodes.map(n => n.responseId));
  const inDegree = new Map<number, number>();
  const adjList = new Map<number, number[]>();

  for (const node of nodes) {
    inDegree.set(node.responseId, 0);
    adjList.set(node.responseId, []);
  }

  for (const node of nodes) {
    for (const dep of node.dependencies) {
      if (nodeIds.has(dep)) {
        adjList.get(dep)?.push(node.responseId);
        inDegree.set(node.responseId, (inDegree.get(node.responseId) || 0) + 1);
      }
    }
  }

  const levels: ExecutionLevel[] = [];
  let queue = nodes
    .filter(n => (inDegree.get(n.responseId) || 0) === 0)
    .map(n => n.responseId);

  let levelNum = 0;
  while (queue.length > 0) {
    const levelNodes = queue.map(rid => nodeMap.get(rid)!).filter(Boolean);
    const maxDuration = Math.max(...levelNodes.map(n => n.durationMs), 0);
    levels.push({ level: levelNum, nodes: levelNodes, maxDurationMs: maxDuration });

    const nextQueue: number[] = [];
    for (const rid of queue) {
      for (const next of (adjList.get(rid) || [])) {
        const deg = (inDegree.get(next) || 0) - 1;
        inDegree.set(next, deg);
        if (deg === 0) { nextQueue.push(next); }
      }
    }
    queue = nextQueue;
    levelNum++;
  }

  return levels;
}

// ── Helpers ──────────────────────────────────────────────────────

function tickerBar(value: number, max: number, width: number): string {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  const empty = width - filled;
  return `<span class="tk-fill">${"\u2588".repeat(filled)}</span><span class="tk-empty">${"\u2591".repeat(empty)}</span>`;
}

// ── Orbital Ring SVG ─────────────────────────────────────────────

function buildOrbitalSvg(speedup: number, savingsPct: number): string {
  const cx = 90, cy = 90;

  // Three rings: outer=sequential, middle=parallel, inner=speedup
  function arcPath(r: number, fraction: number): string {
    const startAngle = -Math.PI / 2;
    const endAngle = startAngle + Math.PI * 2 * Math.min(fraction, 0.9999);
    const largeArc = fraction > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    return `M${x1},${y1} A${r},${r} 0 ${largeArc} 1 ${x2},${y2}`;
  }

  return `<svg viewBox="0 0 180 180" class="orbital-svg" xmlns="http://www.w3.org/2000/svg">
    <!-- Track rings -->
    <circle cx="${cx}" cy="${cy}" r="76" class="orbital-track"/>
    <circle cx="${cx}" cy="${cy}" r="62" class="orbital-track"/>
    <circle cx="${cx}" cy="${cy}" r="48" class="orbital-track"/>

    <!-- Filled arcs (CSS animation draws them) -->
    <path d="${arcPath(76, 1)}" class="orbital-arc orbital-arc-outer"/>
    <path d="${arcPath(62, savingsPct > 0 ? 1 - savingsPct / 100 : 1)}" class="orbital-arc orbital-arc-middle"/>
    <path d="${arcPath(48, Math.min(savingsPct / 100, 1))}" class="orbital-arc orbital-arc-inner"/>

    <!-- Center label -->
    <text x="${cx}" y="${cy - 4}" text-anchor="middle" class="orbital-value">${speedup.toFixed(1)}x</text>
    <text x="${cx}" y="${cy + 12}" text-anchor="middle" class="orbital-label">speedup</text>
  </svg>`;
}

// ── DAG SVG (theme-adaptive using CSS vars in style attrs) ───────

function buildDagSvg(plan: PlanData): string {
  const { levels, edges } = plan;
  if (levels.length === 0) { return ""; }

  const nodeW = 150;
  const nodeH = 52;
  const levelGap = 70;
  const nodeGap = 16;
  const padX = 30;
  const padY = 24;

  const positions = new Map<number, { x: number; y: number; node: PlanNode }>();
  const maxNodesInLevel = Math.max(...levels.map(l => l.nodes.length));
  const maxHeight = maxNodesInLevel * (nodeH + nodeGap) - nodeGap;

  levels.forEach((level, li) => {
    const levelX = padX + li * (nodeW + levelGap);
    const levelHeight = level.nodes.length * (nodeH + nodeGap) - nodeGap;
    const offsetY = padY + (maxHeight - levelHeight) / 2;

    level.nodes.forEach((node, ni) => {
      positions.set(node.responseId, {
        x: levelX,
        y: offsetY + ni * (nodeH + nodeGap),
        node,
      });
    });
  });

  const svgW = padX + levels.length * (nodeW + levelGap) - levelGap + padX;
  const svgH = padY * 2 + maxHeight;

  let svg = `<svg width="${svgW}" height="${svgH}" xmlns="http://www.w3.org/2000/svg">`;

  // Defs — using style attributes for theme-adaptive colors
  svg += `<defs>
    <marker id="ah" viewBox="0 0 10 7" refX="10" refY="3.5"
      markerWidth="8" markerHeight="6" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" style="fill: var(--edge-color)"/>
    </marker>
  </defs>`;

  // Level bands
  levels.forEach((level, li) => {
    const lx = padX + li * (nodeW + levelGap) - 10;
    if (li % 2 === 0) {
      svg += `<rect x="${lx}" y="4" width="${nodeW + 20}" height="${svgH - 8}" rx="8" style="fill: var(--level-band)"/>`;
    }
    svg += `<text x="${lx + (nodeW + 20) / 2}" y="${svgH - 6}" text-anchor="middle" font-size="10" style="fill: var(--fg-dim)" opacity="0.5">L${li}</text>`;
  });

  // Edges
  for (const edge of edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) { continue; }

    const x1 = from.x + nodeW;
    const y1 = from.y + nodeH / 2;
    const x2 = to.x;
    const y2 = to.y + nodeH / 2;
    const cx = (x1 + x2) / 2;

    svg += `<path d="M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}" style="fill: none; stroke: var(--edge-color); stroke-opacity: 0.4; stroke-width: 1.5" marker-end="url(#ah)"/>`;
  }

  // Nodes
  positions.forEach((pos) => {
    const n = pos.node;
    const nodeClass = n.hasError ? "dag-node-error" : (n.dependencies.length === 0 ? "dag-node-independent" : "dag-node-dependent");

    svg += `<g transform="translate(${pos.x},${pos.y})">`;
    svg += `<rect width="${nodeW}" height="${nodeH}" rx="8" ry="8" class="${nodeClass}"/>`;
    svg += `<text x="12" y="20" font-size="11" font-weight="700" class="dag-node-text">@${n.responseId}</text>`;

    const maxChars = Math.floor((nodeW - 24) / 7);
    const toolLabel = n.toolName.length > maxChars ? n.toolName.slice(0, maxChars) + "\u2026" : n.toolName;
    svg += `<text x="12" y="38" font-size="10" class="dag-node-text" opacity="0.8">${esc(toolLabel)}</text>`;
    svg += `<text x="${nodeW - 10}" y="20" text-anchor="end" font-size="10" class="dag-node-text" opacity="0.7">${fmtMs(n.durationMs)}</text>`;
    svg += `</g>`;
  });

  svg += `</svg>`;
  return svg;
}

function buildPlanHtml(wsName: string, plan: PlanData): string {
  const savingsPct = plan.totalSequentialMs > 0
    ? Math.round(((plan.totalSequentialMs - plan.totalParallelMs) / plan.totalSequentialMs) * 100)
    : 0;

  const dagSvg = buildDagSvg(plan);
  const barWidth = 28;

  // Level cards HTML
  const levelCardsHtml = plan.levels.map(level => {
    const isParallel = level.nodes.length > 1;
    const badgeClass = isParallel ? "badge-parallel" : "badge-sequential";
    const badgeText = isParallel ? `${level.nodes.length} parallel` : "sequential";

    const rows = level.nodes.map(n =>
      `<div class="level-row">
        <span class="level-rid">@${n.responseId}</span>
        <span class="level-tool">${esc(n.toolName)}</span>
        <span class="level-dur">${fmtMs(n.durationMs)}</span>
      </div>`
    ).join("");

    const maxLine = isParallel
      ? `<div class="level-max">max duration: ${fmtMs(level.maxDurationMs)} (determines level time)</div>`
      : "";

    return `<div class="level-card">
      <div class="level-header">
        <span class="level-label">Level ${level.level}</span>
        <span class="level-badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="level-body">${rows}${maxLine}</div>
    </div>`;
  }).join("");

  // Warning cards
  const warningsHtml = plan.duplicates.length > 0
    ? `<div class="warnings-section">
        <div class="section-label warnings-title">Performance Warnings</div>
        ${plan.duplicates.map(dup =>
          `<div class="warning-card">
            <div class="warning-label">Redundant: ${esc(dup.toolName)}</div>
            <div class="warning-detail">${dup.count} identical calls &middot; ${fmtMs(dup.wastedMs)} wasted</div>
          </div>`
        ).join("")}
      </div>`
    : "";

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
    --mono: var(--vscode-editor-font-family, 'SF Mono', 'Fira Code', monospace);
  }

  body.vscode-dark, body.vscode-high-contrast {
    --success: #4ec9b0;
    --error: #f14c4c;
    --orange: #E87A2A;
    --ticker-bg: rgba(255,255,255,0.03);
    --level-band: rgba(128,128,128,0.06);
    --edge-color: #888;
    --node-independent-bg: #1a6b52;
    --node-dependent-bg: #1a5a8a;
    --node-error-bg: #8a2020;
    --node-text: #fff;
    --orbital-track: rgba(128,128,128,0.15);
    --orbital-outer: #666;
    --orbital-middle: var(--accent);
    --orbital-inner: #4ec9b0;
  }

  body.vscode-light {
    --success: #16825d;
    --error: #cd3131;
    --orange: #c05621;
    --ticker-bg: rgba(0,0,0,0.03);
    --level-band: rgba(0,0,0,0.04);
    --edge-color: #999;
    --node-independent-bg: #16825d;
    --node-dependent-bg: #2a7ab5;
    --node-error-bg: #cd3131;
    --node-text: #fff;
    --orbital-track: rgba(0,0,0,0.08);
    --orbital-outer: #999;
    --orbital-middle: var(--accent);
    --orbital-inner: #16825d;
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

  .header { margin-bottom: 28px; }
  .header h1 { font-size: 1.4em; font-weight: 600; }
  .header .subtitle { color: var(--fg-dim); font-size: 0.9em; margin-top: 4px; }

  /* ── Terminal Ticker ───────────── */
  .ticker {
    background: var(--ticker-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 20px;
    margin-bottom: 28px;
    font-family: var(--mono);
    font-size: 13px;
  }
  .ticker-line {
    line-height: 2.4;
    white-space: pre;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .tk-label {
    color: var(--fg-dim);
    display: inline-block;
    width: 14ch;
    flex-shrink: 0;
  }
  .tk-fill { color: var(--success); }
  .tk-empty { color: var(--border); opacity: 0.5; }
  .tk-val {
    color: var(--fg);
    font-weight: 600;
    margin-left: 4px;
    min-width: 8ch;
    text-align: right;
  }
  .tk-dim { color: var(--fg-dim); font-size: 0.9em; }

  .section-label {
    font-size: 0.68em; text-transform: uppercase;
    letter-spacing: 0.1em; color: var(--fg-dim);
    margin-bottom: 10px;
  }

  /* ── Ticker + Orbital layout ───── */
  .top-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 28px;
    align-items: start;
    margin-bottom: 28px;
  }

  /* ── Orbital Ring ──────────────── */
  .orbital-container { text-align: center; }
  .orbital-svg { width: 160px; height: 160px; }
  .orbital-track {
    fill: none;
    stroke: var(--orbital-track);
    stroke-width: 8;
  }
  .orbital-arc {
    fill: none;
    stroke-width: 8;
    stroke-linecap: round;
    stroke-dasharray: 1000;
    stroke-dashoffset: 1000;
    animation: orbital-draw 1.2s ease-out forwards;
  }
  .orbital-arc-outer { stroke: var(--orbital-outer); opacity: 0.5; }
  .orbital-arc-middle { stroke: var(--orbital-middle); }
  .orbital-arc-inner { stroke: var(--orbital-inner); }
  @keyframes orbital-draw {
    to { stroke-dashoffset: 0; }
  }
  .orbital-value {
    font-family: var(--mono);
    font-size: 22px;
    font-weight: 700;
    fill: var(--fg);
  }
  .orbital-label {
    font-family: var(--mono);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    fill: var(--fg-dim);
  }
  .orbital-caption {
    font-size: 0.68em; color: var(--fg-dim);
    text-transform: uppercase; letter-spacing: 0.08em;
    margin-top: 6px;
  }

  /* ── DAG ────────────────────────── */
  .dag-section { margin-bottom: 32px; }
  .dag-container { width: 100%; overflow-x: auto; }
  .dag-container svg { display: block; }

  .dag-node-independent {
    fill: var(--node-independent-bg);
    opacity: 0.85;
  }
  .dag-node-dependent {
    fill: var(--node-dependent-bg);
    opacity: 0.85;
  }
  .dag-node-error {
    fill: var(--node-error-bg);
    opacity: 0.85;
    stroke: var(--error);
    stroke-width: 2;
  }
  .dag-node-text {
    fill: var(--node-text);
  }

  /* ── Levels ────────────────────── */
  .levels-section { margin-bottom: 32px; }

  .level-card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 18px;
    margin-bottom: 8px;
  }
  .level-header {
    display: flex; justify-content: space-between;
    align-items: center;
  }
  .level-label { font-weight: 600; font-size: 0.9em; }
  .level-badge {
    font-size: 0.72em; padding: 2px 8px;
    border-radius: 4px; font-weight: 500;
  }
  .badge-parallel { background: color-mix(in srgb, var(--success) 15%, transparent); color: var(--success); }
  .badge-sequential { background: color-mix(in srgb, var(--fg-dim) 15%, transparent); color: var(--fg-dim); }

  .level-body { margin-top: 8px; }
  .level-row {
    display: flex; align-items: center; gap: 10px;
    padding: 6px 0; font-size: 0.82em;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 30%, transparent);
  }
  .level-row:last-child { border-bottom: none; }
  .level-rid {
    font-family: var(--mono); font-size: 0.85em;
    color: var(--fg-dim); flex-shrink: 0; width: 36px;
  }
  .level-tool { flex: 1; font-weight: 500; }
  .level-dur {
    font-family: var(--mono); font-size: 0.85em;
    color: var(--fg-dim); flex-shrink: 0;
  }
  .level-max {
    font-size: 0.72em; color: var(--fg-dim);
    margin-top: 6px; font-style: italic;
  }

  /* ── Warnings ──────────────────── */
  .warnings-section { margin-bottom: 32px; }
  .warnings-title { color: var(--orange) !important; }
  .warning-card {
    background: color-mix(in srgb, var(--orange) 6%, transparent);
    border: 1px solid color-mix(in srgb, var(--orange) 25%, transparent);
    border-radius: 8px; padding: 12px 16px;
    margin-bottom: 6px; font-size: 0.85em;
  }
  .warning-label { color: var(--orange); font-weight: 500; }
  .warning-detail { color: var(--fg-dim); margin-top: 4px; }

  footer { margin-top: 24px; font-size: 0.72em; color: var(--fg-dim); }
</style>
</head>
<body>
  <div class="header">
    <h1>${esc(wsName)}</h1>
    <div class="subtitle">${plan.levels.length} execution levels &middot; ${plan.nodes.length} responses</div>
  </div>

  <!-- Ticker + Orbital Ring -->
  <div class="top-row">
    <div class="ticker">
      <div class="ticker-line">
        <span class="tk-label">actual time</span>
        ${tickerBar(plan.totalSequentialMs, plan.totalSequentialMs, barWidth)}
        <span class="tk-val">${fmtMs(plan.totalSequentialMs)}</span>
        <span class="tk-dim">sequential</span>
      </div>
      <div class="ticker-line">
        <span class="tk-label">parallel time</span>
        ${tickerBar(plan.totalParallelMs, plan.totalSequentialMs, barWidth)}
        <span class="tk-val">${fmtMs(plan.totalParallelMs)}</span>
        <span class="tk-dim">with parallelization</span>
      </div>
      <div class="ticker-line">
        <span class="tk-label">speedup</span>
        ${tickerBar(savingsPct, 100, barWidth)}
        <span class="tk-val">${plan.speedup.toFixed(1)}x</span>
        <span class="tk-dim">${savingsPct}% faster</span>
      </div>
    </div>
    <div class="orbital-container">
      ${buildOrbitalSvg(plan.speedup, savingsPct)}
      <div class="orbital-caption">${savingsPct}% savings</div>
    </div>
  </div>

  <div class="dag-section">
    <div class="section-label">Execution Plan DAG</div>
    <div class="dag-container">${dagSvg}</div>
  </div>

  <div class="levels-section">
    <div class="section-label">Execution Levels</div>
    ${levelCardsHtml}
  </div>

  ${warningsHtml}

  <footer>modiqo &middot; dex plan</footer>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
