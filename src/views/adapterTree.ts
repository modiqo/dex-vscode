import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { DexClient, Adapter } from "../client/dexClient";

/** Node kinds in the adapter tree */
type NodeKind =
  | "adapter"
  | "section"
  | "detail"
  | "log-entry"
  | "policy-section"
  | "policy-subsection";

export class AdapterTreeItem extends vscode.TreeItem {
  public policyData?: Record<string, unknown>;
  public policySubKind?: "config" | "live-stats";

  constructor(
    public readonly adapter: Adapter,
    public readonly kind: NodeKind,
    collapsible: vscode.TreeItemCollapsibleState,
    label: string,
    private extUri?: vscode.Uri
  ) {
    super(label, collapsible);
    this.applyKindStyle();
  }

  private applyKindStyle(): void {
    switch (this.kind) {
      case "adapter":
        this.id = `adapter-${this.adapter.id}`;
        this.description = this.adapter.id;
        this.tooltip = this.buildAdapterTooltip();
        this.contextValue = this.adapter.has_token
          ? "adapter-ok"
          : "adapter-token-missing";
        if (this.extUri) {
          this.iconPath = {
            light: vscode.Uri.joinPath(this.extUri, "media", "light", "adapter.svg"),
            dark: vscode.Uri.joinPath(this.extUri, "media", "dark", "adapter.svg"),
          };
        }
        break;

      case "section": {
        this.contextValue = "adapter-section";
        const sectionLabel = this.label as string;
        if (this.extUri) {
          if (sectionLabel.startsWith("Logs")) {
            this.iconPath = {
              light: vscode.Uri.joinPath(this.extUri, "media", "light", "logs.svg"),
              dark: vscode.Uri.joinPath(this.extUri, "media", "dark", "logs.svg"),
            };
          } else if (sectionLabel === "Policies") {
            this.iconPath = {
              light: vscode.Uri.joinPath(this.extUri, "media", "light", "policy.svg"),
              dark: vscode.Uri.joinPath(this.extUri, "media", "dark", "policy.svg"),
            };
          } else {
            this.iconPath = new vscode.ThemeIcon("info");
          }
        }
        break;
      }

      case "detail":
        this.iconPath = new vscode.ThemeIcon("dash");
        this.contextValue = "adapter-detail";
        break;

      case "log-entry":
        this.contextValue = "adapter-log";
        break;

      case "policy-section":
        this.contextValue = "adapter-policy";
        break;

      case "policy-subsection":
        this.contextValue = "adapter-policy-sub";
        break;
    }
  }

  private buildAdapterTooltip(): string {
    const a = this.adapter;
    const lines = [a.name, `ID: ${a.id}`];
    if (a.group) { lines.push(`Group: ${a.group}`); }
    if (a.tools) { lines.push(`Tools: ${a.tools}`); }
    if (a.spec_type) { lines.push(`Type: ${a.spec_type}`); }
    if (a.usage) { lines.push(`Usage: ${a.usage}`); }
    lines.push(a.has_token ? "Status: Ready" : "Status: Token missing");
    return lines.join("\n");
  }
}

export class AdapterTreeProvider
  implements vscode.TreeDataProvider<AdapterTreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    AdapterTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private adapters: Adapter[] = [];
  private extUri: vscode.Uri | undefined;

  constructor(private client: DexClient) {}

  setExtensionUri(uri: vscode.Uri): void {
    this.extUri = uri;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: AdapterTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(
    element?: AdapterTreeItem
  ): Promise<AdapterTreeItem[]> {
    // Root — list adapters
    if (!element) {
      try {
        this.adapters = await this.client.adapterList();
      } catch {
        this.adapters = [];
      }
      return this.adapters.map((a) => {
        const label = a.group ? `${a.name} [${a.group}]` : a.name;
        return new AdapterTreeItem(
          a, "adapter", vscode.TreeItemCollapsibleState.Collapsed,
          label, this.extUri
        );
      });
    }

    // Adapter → Info, Logs, Policies sections
    if (element.kind === "adapter") {
      return this.buildAdapterSections(element.adapter);
    }

    // Section → children
    if (element.kind === "section") {
      const sectionLabel = element.label as string;
      if (sectionLabel === "Info") { return this.buildInfoRows(element.adapter); }
      if (sectionLabel.startsWith("Logs")) { return this.buildLogRows(element.adapter); }
      if (sectionLabel === "Policies") { return this.buildPolicyRows(element.adapter); }
    }

    // Policy subsection → Config or Live Stats
    if (element.kind === "policy-subsection") {
      if (element.policySubKind === "config") {
        return this.buildPolicyConfigRows(element.adapter);
      }
      if (element.policySubKind === "live-stats") {
        return this.buildPolicyLiveStats(element.adapter);
      }
    }

    // Policy sub-section → detail rows
    if (element.kind === "policy-section" && element.policyData) {
      return this.flattenObject(element.adapter, element.policyData);
    }

    return [];
  }

  // ── Adapter sections ────────────────────────────────────────────

  private buildAdapterSections(a: Adapter): AdapterTreeItem[] {
    const children: AdapterTreeItem[] = [];

    children.push(new AdapterTreeItem(
      a, "section", vscode.TreeItemCollapsibleState.Collapsed,
      "Info", this.extUri
    ));

    const logPath = path.join(os.homedir(), ".dex", "adapters", a.id, "logs", "requests.jsonl");
    if (fs.existsSync(logPath)) {
      const count = this.countLines(logPath);
      children.push(new AdapterTreeItem(
        a, "section", vscode.TreeItemCollapsibleState.Collapsed,
        `Logs (${count})`, this.extUri
      ));
    }

    const policyPath = path.join(os.homedir(), ".dex", "adapters", a.id, "config", "policies.json");
    if (fs.existsSync(policyPath)) {
      children.push(new AdapterTreeItem(
        a, "section", vscode.TreeItemCollapsibleState.Collapsed,
        "Policies", this.extUri
      ));
    }

    return children;
  }

  // ── Info rows ───────────────────────────────────────────────────

  private buildInfoRows(a: Adapter): AdapterTreeItem[] {
    const rows: AdapterTreeItem[] = [];
    if (a.tools) { rows.push(this.detailRow(a, `Tools: ${a.tools}`)); }
    if (a.spec_type) { rows.push(this.detailRow(a, `Type: ${a.spec_type}`)); }
    if (a.usage) { rows.push(this.detailRow(a, `Usage: ${a.usage}`)); }
    if (a.success) { rows.push(this.detailRow(a, `Success: ${a.success}`)); }
    if (a.group) { rows.push(this.detailRow(a, `Group: ${a.group}`)); }
    rows.push(this.detailRow(a, a.has_token ? "Status: ready" : "Status: token missing"));

    // Auth token info from manifest
    const authInfo = this.readAuthInfoFromManifest(a.id);
    if (authInfo) {
      const item = this.detailRow(a, `Auth token: ${authInfo.envVar}`);
      item.tooltip = authInfo.description
        ? `${authInfo.label}\n${authInfo.description}`
        : authInfo.label;
      rows.push(item);
    }

    return rows;
  }

  /** Read auth token env var name from adapter manifest.json */
  private readAuthInfoFromManifest(
    adapterId: string
  ): { envVar: string; label: string; description?: string } | undefined {
    const manifestPath = path.join(
      os.homedir(), ".dex", "adapters", adapterId, "manifest.json"
    );
    try {
      const content = fs.readFileSync(manifestPath, "utf-8");
      const manifest = JSON.parse(content);
      const auth = manifest?.auth;
      if (!auth) { return undefined; }

      // No-auth APIs
      if (auth.type === "none") { return undefined; }

      // Simple auth: top-level token_env or key_env
      if (auth.token_env) {
        return { envVar: auth.token_env, label: "Bearer token", description: auth.description };
      }
      if (auth.key_env) {
        return { envVar: auth.key_env, label: "API key", description: auth.description };
      }

      // Per-operation auth: use default scheme
      const defaultScheme = auth.default_scheme;
      if (defaultScheme && auth.schemes?.[defaultScheme]) {
        const scheme = auth.schemes[defaultScheme];
        if (scheme.token_env) {
          return { envVar: scheme.token_env, label: `Bearer token (${defaultScheme})`, description: scheme.description };
        }
        if (scheme.key_env) {
          return { envVar: scheme.key_env, label: `API key (${defaultScheme})`, description: scheme.description };
        }
      }

      // Multi-scheme without default: show first available
      if (auth.schemes) {
        for (const [schemeName, scheme] of Object.entries(auth.schemes as Record<string, { token_env?: string; key_env?: string; description?: string }>)) {
          if (scheme.token_env) {
            return { envVar: scheme.token_env, label: `Bearer token (${schemeName})`, description: scheme.description };
          }
          if (scheme.key_env) {
            return { envVar: scheme.key_env, label: `API key (${schemeName})`, description: scheme.description };
          }
        }
      }
    } catch {
      // Manifest unreadable — skip
    }
    return undefined;
  }

  // ── Log rows ────────────────────────────────────────────────────

  private buildLogRows(a: Adapter): AdapterTreeItem[] {
    const logPath = path.join(os.homedir(), ".dex", "adapters", a.id, "logs", "requests.jsonl");
    try {
      const content = fs.readFileSync(logPath, "utf-8");
      const lines = content.trim().split("\n").filter((l) => l.length > 0);

      interface LogEntry {
        timestamp: string;
        tool: string;
        method: string;
        url: string;
        status: number | null;
        duration_ms: number | null;
        error: string | null;
      }

      const entries: LogEntry[] = [];
      for (const line of lines) {
        try { entries.push(JSON.parse(line)); } catch { /* skip */ }
      }

      // Completed requests (have a status code) — most recent first
      const completed = entries.filter((e) => e.status !== null).reverse().slice(0, 25);
      const rows: AdapterTreeItem[] = [];

      for (const entry of completed) {
        const ts = this.formatTimestamp(entry.timestamp);
        const status = entry.status ?? 0;
        const duration = entry.duration_ms ? `${entry.duration_ms}ms` : "";

        const statusIcon = status >= 200 && status < 300
          ? "pass"
          : status >= 400
            ? "error"
            : "circle-outline";

        const item = new AdapterTreeItem(
          a, "log-entry", vscode.TreeItemCollapsibleState.None,
          entry.tool, this.extUri
        );
        item.description = [String(status), duration, ts].filter(Boolean).join("  ");
        item.tooltip = new vscode.MarkdownString([
          `**${entry.tool}**`,
          "",
          `| Field | Value |`,
          `|-------|-------|`,
          `| Method | \`${entry.method}\` |`,
          `| URL | \`${entry.url}\` |`,
          `| Status | ${status} |`,
          duration ? `| Duration | ${duration} |` : "",
          `| Time | ${entry.timestamp} |`,
          entry.error ? `| Error | ${entry.error} |` : "",
        ].filter(Boolean).join("\n"));
        item.iconPath = new vscode.ThemeIcon(statusIcon);

        rows.push(item);
      }

      if (rows.length === 0) {
        rows.push(this.detailRow(a, "No completed requests"));
      }

      return rows;
    } catch {
      return [this.detailRow(a, "Unable to read logs")];
    }
  }

  // ── Policy rows ─────────────────────────────────────────────────

  private buildPolicyRows(a: Adapter): AdapterTreeItem[] {
    const rows: AdapterTreeItem[] = [];

    // Config subtree
    const configItem = new AdapterTreeItem(
      a, "policy-subsection", vscode.TreeItemCollapsibleState.Collapsed,
      "Config", this.extUri
    );
    configItem.iconPath = new vscode.ThemeIcon("settings-gear");
    configItem.policySubKind = "config";
    rows.push(configItem);

    // Live Stats subtree
    const liveItem = new AdapterTreeItem(
      a, "policy-subsection", vscode.TreeItemCollapsibleState.Collapsed,
      "Live Stats (24h)", this.extUri
    );
    liveItem.iconPath = new vscode.ThemeIcon("pulse");
    liveItem.policySubKind = "live-stats";
    rows.push(liveItem);

    return rows;
  }

  private buildPolicyConfigRows(a: Adapter): AdapterTreeItem[] {
    const policyPath = path.join(os.homedir(), ".dex", "adapters", a.id, "config", "policies.json");
    try {
      const content = fs.readFileSync(policyPath, "utf-8");
      const policies = JSON.parse(content);
      const rows: AdapterTreeItem[] = [];

      // Enabled row
      const enabledItem = this.detailRow(a, policies.enabled ? "Enabled: yes" : "Enabled: no");
      enabledItem.iconPath = new vscode.ThemeIcon(policies.enabled ? "pass" : "circle-slash");
      rows.push(enabledItem);

      // Major policy sections
      const sections: Array<[string, string, string]> = [
        ["rate_limits", "Rate Limits", "dashboard"],
        ["timeouts", "Timeouts", "watch"],
        ["retry", "Retry", "refresh"],
        ["circuit_breaker", "Circuit Breaker", "shield"],
        ["logging", "Logging", "output"],
      ];

      for (const [key, label, icon] of sections) {
        if (policies[key] && typeof policies[key] === "object") {
          const item = new AdapterTreeItem(
            a, "policy-section", vscode.TreeItemCollapsibleState.Collapsed,
            label, this.extUri
          );
          item.iconPath = new vscode.ThemeIcon(icon);
          item.policyData = policies[key];
          rows.push(item);
        }
      }

      return rows;
    } catch {
      return [this.detailRow(a, "Unable to read policies")];
    }
  }

  private async buildPolicyLiveStats(a: Adapter): Promise<AdapterTreeItem[]> {
    try {
      const data = await this.client.execJson<PsEndpointJson>(
        ["ps", "--json", "--endpoint", `adapter/${a.id}`, "--detailed", "--window", "24h"]
      );
      const rows: AdapterTreeItem[] = [];
      rows.push(this.detailRow(a, `Requests: ${data.total_requests}`));
      rows.push(this.detailRow(a, `Success rate: ${(data.success_rate * 100).toFixed(1)}%`));

      const pv = data.policy_violations;
      rows.push(this.detailRow(a, `Policy rejected: ${pv.total}`));
      rows.push(this.detailRow(a, `Rate limit rejects: ${pv.rate_limit}`));
      rows.push(this.detailRow(a, `Circuit breaker trips: ${pv.circuit_breaker}`));
      rows.push(this.detailRow(a, `Violation rate: ${(pv.violation_rate * 100).toFixed(1)}%`));

      rows.push(this.detailRow(a, `p50 latency: ${data.latency.p50.toFixed(0)}ms`));
      rows.push(this.detailRow(a, `p95 latency: ${data.latency.p95.toFixed(0)}ms`));
      rows.push(this.detailRow(a, `Estimated cost: $${data.estimated_cost.toFixed(4)}`));
      return rows;
    } catch {
      return [this.detailRow(a, "No stats available")];
    }
  }

  /** Recursively flatten a policy object into detail rows */
  private flattenObject(a: Adapter, obj: Record<string, unknown>): AdapterTreeItem[] {
    const rows: AdapterTreeItem[] = [];
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) { continue; }

      if (typeof value === "object" && !Array.isArray(value)) {
        const item = new AdapterTreeItem(
          a, "policy-section", vscode.TreeItemCollapsibleState.Collapsed,
          key, this.extUri
        );
        item.iconPath = new vscode.ThemeIcon("json");
        item.policyData = value as Record<string, unknown>;
        rows.push(item);
      } else if (Array.isArray(value)) {
        rows.push(this.detailRow(a, `${key}: [${value.join(", ")}]`));
      } else {
        const display = typeof value === "boolean" ? (value ? "yes" : "no") : String(value);
        rows.push(this.detailRow(a, `${key}: ${display}`));
      }
    }
    return rows;
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private detailRow(a: Adapter, text: string): AdapterTreeItem {
    return new AdapterTreeItem(
      a, "detail", vscode.TreeItemCollapsibleState.None, text, this.extUri
    );
  }

  private countLines(filePath: string): number {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return content.trim().split("\n").filter((l) => l.length > 0).length;
    } catch {
      return 0;
    }
  }

  private formatTimestamp(ts: string): string {
    try {
      const d = new Date(ts);
      const diffMs = Date.now() - d.getTime();
      const mins = Math.floor(diffMs / 60000);
      if (mins < 1) { return "now"; }
      if (mins < 60) { return `${mins}m ago`; }
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) { return `${hrs}h ago`; }
      return `${Math.floor(hrs / 24)}d ago`;
    } catch {
      return ts;
    }
  }
}

/** Shape of `dex ps --json --endpoint X --detailed` */
interface PsEndpointJson {
  endpoint: string;
  window: string;
  total_requests: number;
  successful: number;
  failed: number;
  success_rate: number;
  latency: { p50: number; p95: number; p99: number; avg: number };
  tokens: { request: number; response: number; total: number };
  estimated_cost: number;
  activity: { rps: number; active_sessions: number };
  policy_violations: {
    total: number;
    rate_limit: number;
    circuit_breaker: number;
    violation_rate: number;
    last_violation: string | null;
  };
}
