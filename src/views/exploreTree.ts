import * as vscode from "vscode";
import type {
  DexClient,
  ExploreResult,
  ExploreToolMatch,
  ExploreSkillMatch,
  FlowSearchMatch,
} from "../client/dexClient";

type ExploreNodeKind =
  | "search-prompt"
  | "loading"
  | "section"
  | "skill-match"
  | "flow-search-match"
  | "adapter-group"
  | "tool-match"
  | "empty";

export class ExploreTreeItem extends vscode.TreeItem {
  constructor(
    public readonly kind: ExploreNodeKind,
    collapsible: vscode.TreeItemCollapsibleState,
    label: string,
    public readonly adapterId?: string,
    public readonly toolMatch?: ExploreToolMatch,
    public readonly skillMatch?: ExploreSkillMatch,
    public readonly flowSearchMatch?: FlowSearchMatch,
    private extUri?: vscode.Uri
  ) {
    super(label, collapsible);
    this.applyStyle();
  }

  private applyStyle(): void {
    switch (this.kind) {
      case "search-prompt":
        this.iconPath = new vscode.ThemeIcon("search");
        this.contextValue = "explore-search";
        this.command = {
          command: "modiqo.exploreSearch",
          title: "Search",
        };
        break;

      case "loading":
        this.iconPath = new vscode.ThemeIcon(
          "loading~spin",
          new vscode.ThemeColor("progressBar.background")
        );
        this.contextValue = "explore-loading";
        break;

      case "section":
        this.contextValue = "explore-section";
        if ((this.label as string).startsWith("Flows")) {
          this.iconPath = this.extUri
            ? {
                light: vscode.Uri.joinPath(this.extUri, "media", "light", "flow.svg"),
                dark: vscode.Uri.joinPath(this.extUri, "media", "dark", "flow.svg"),
              }
            : new vscode.ThemeIcon("zap");
        } else if ((this.label as string).startsWith("Adapters")) {
          this.iconPath = this.extUri
            ? {
                light: vscode.Uri.joinPath(this.extUri, "media", "light", "adapter.svg"),
                dark: vscode.Uri.joinPath(this.extUri, "media", "dark", "adapter.svg"),
              }
            : new vscode.ThemeIcon("plug");
        }
        break;

      case "skill-match":
        if (this.skillMatch) {
          this.description = this.skillMatch.matchPercent;
          this.tooltip = new vscode.MarkdownString([
            `**${this.skillMatch.name}**`,
            "",
            this.skillMatch.description,
            "",
            `Match: ${this.skillMatch.matchPercent}`,
          ].join("\n"));
          this.iconPath = new vscode.ThemeIcon("symbol-method");
          this.contextValue = "explore-skill";
        }
        break;

      case "adapter-group":
        this.iconPath = new vscode.ThemeIcon("package");
        this.contextValue = "explore-adapter";
        break;

      case "tool-match":
        if (this.toolMatch) {
          const pct = Math.round(this.toolMatch.score);
          this.description = `${pct}%`;
          this.tooltip = new vscode.MarkdownString([
            `**${this.toolMatch.tool}**`,
            "",
            this.toolMatch.description,
            "",
            `| Field | Value |`,
            `|-------|-------|`,
            `| Adapter | ${this.toolMatch.adapter_id} |`,
            `| Toolset | ${this.toolMatch.toolset} |`,
            `| Score | ${pct}% |`,
            `| Group | ${this.toolMatch.group} |`,
          ].join("\n"));
          this.iconPath = new vscode.ThemeIcon("wrench");
          this.contextValue = "explore-tool";
        }
        break;

      case "flow-search-match":
        if (this.flowSearchMatch) {
          const fm = this.flowSearchMatch;
          this.description = `${fm.matchPercent}%  [${fm.flowType}]`;
          this.tooltip = new vscode.MarkdownString([
            `**${fm.name}**  \`${fm.flowType}\``,
            "",
            fm.description,
            "",
            `| Field | Value |`,
            `|-------|-------|`,
            `| Match | ${fm.matchPercent}% |`,
            `| Adapter | ${fm.adapter} |`,
            `| Endpoints | ${fm.endpoints} |`,
            `| Location | ${fm.location} |`,
          ].join("\n"));
          this.iconPath = this.extUri
            ? {
                light: vscode.Uri.joinPath(this.extUri, "media", "light", "flow.svg"),
                dark: vscode.Uri.joinPath(this.extUri, "media", "dark", "flow.svg"),
              }
            : new vscode.ThemeIcon("zap");
          this.contextValue = "explore-flow-search";
        }
        break;

      case "empty":
        this.iconPath = new vscode.ThemeIcon("info");
        this.contextValue = "explore-empty";
        break;
    }
  }
}

export class ExploreTreeProvider
  implements vscode.TreeDataProvider<ExploreTreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    ExploreTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private extUri: vscode.Uri | undefined;
  private searching = false;
  public cachedResult: ExploreResult | null = null;

  constructor(private client: DexClient) {}

  setExtensionUri(uri: vscode.Uri): void {
    this.extUri = uri;
  }

  refresh(): void {
    this.cachedResult = null;
    this.searching = false;
    this._onDidChangeTreeData.fire();
  }

  async search(query: string): Promise<void> {
    this.searching = true;
    this.cachedResult = null;
    this._onDidChangeTreeData.fire();

    try {
      this.cachedResult = await this.client.explore(query);
    } catch {
      this.cachedResult = { query, tools: [], skills: [], flowSearchResults: [] };
    }

    this.searching = false;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ExploreTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(
    element?: ExploreTreeItem
  ): Promise<ExploreTreeItem[]> {
    if (!element) {
      return this.buildRoot();
    }

    if (element.kind === "section") {
      const label = element.label as string;
      if (label.startsWith("Flow Search") && this.cachedResult) {
        return this.cachedResult.flowSearchResults.map(
          (f) =>
            new ExploreTreeItem(
              "flow-search-match",
              vscode.TreeItemCollapsibleState.None,
              f.name,
              undefined,
              undefined,
              undefined,
              f,
              this.extUri
            )
        );
      }
      if (label.startsWith("Flows") && this.cachedResult) {
        return this.cachedResult.skills.map(
          (s) =>
            new ExploreTreeItem(
              "skill-match",
              vscode.TreeItemCollapsibleState.None,
              s.name,
              undefined,
              undefined,
              s,
              undefined,
              this.extUri
            )
        );
      }
      if (label.startsWith("Adapters") && this.cachedResult) {
        return this.buildAdapterGroups();
      }
    }

    if (element.kind === "adapter-group" && element.adapterId && this.cachedResult) {
      return this.cachedResult.tools
        .filter((t) => t.adapter_id === element.adapterId)
        .sort((a, b) => b.score - a.score)
        .map(
          (t) =>
            new ExploreTreeItem(
              "tool-match",
              vscode.TreeItemCollapsibleState.None,
              t.tool,
              t.adapter_id,
              t,
              undefined,
              undefined,
              this.extUri
            )
        );
    }

    return [];
  }

  private buildRoot(): ExploreTreeItem[] {
    // Searching — show spinner
    if (this.searching) {
      return [
        new ExploreTreeItem(
          "loading",
          vscode.TreeItemCollapsibleState.None,
          "Searching...",
          undefined,
          undefined,
          undefined,
          undefined,
          this.extUri
        ),
      ];
    }

    // No results yet — show search prompt
    if (!this.cachedResult) {
      return [
        new ExploreTreeItem(
          "search-prompt",
          vscode.TreeItemCollapsibleState.None,
          "Search adapters & flows...",
          undefined,
          undefined,
          undefined,
          undefined,
          this.extUri
        ),
      ];
    }

    // Results loaded
    const items: ExploreTreeItem[] = [];
    const result = this.cachedResult;

    // Search prompt for new search
    const searchItem = new ExploreTreeItem(
      "search-prompt",
      vscode.TreeItemCollapsibleState.None,
      `"${result.query}"`,
      undefined,
      undefined,
      undefined,
      undefined,
      this.extUri
    );
    searchItem.description = "click to search again";
    items.push(searchItem);

    // Flow Search section (richer results from dex flow search)
    if (result.flowSearchResults.length > 0) {
      items.push(
        new ExploreTreeItem(
          "section",
          vscode.TreeItemCollapsibleState.Expanded,
          `Flow Search (${result.flowSearchResults.length})`,
          undefined,
          undefined,
          undefined,
          undefined,
          this.extUri
        )
      );
    }

    // Skills section (from dex explore)
    if (result.skills.length > 0) {
      items.push(
        new ExploreTreeItem(
          "section",
          vscode.TreeItemCollapsibleState.Expanded,
          `Flows (${result.skills.length})`,
          undefined,
          undefined,
          undefined,
          undefined,
          this.extUri
        )
      );
    }

    // Adapters section
    const adapterIds = [...new Set(result.tools.map((t) => t.adapter_id))];
    if (adapterIds.length > 0) {
      items.push(
        new ExploreTreeItem(
          "section",
          vscode.TreeItemCollapsibleState.Expanded,
          `Adapters (${adapterIds.length})`,
          undefined,
          undefined,
          undefined,
          undefined,
          this.extUri
        )
      );
    }

    const hasAny = result.flowSearchResults.length > 0 ||
      result.skills.length > 0 || result.tools.length > 0;
    if (!hasAny) {
      items.push(
        new ExploreTreeItem(
          "empty",
          vscode.TreeItemCollapsibleState.None,
          "No results found",
          undefined,
          undefined,
          undefined,
          undefined,
          this.extUri
        )
      );
    }

    return items;
  }

  private buildAdapterGroups(): ExploreTreeItem[] {
    if (!this.cachedResult) { return []; }

    const adapterMap = new Map<string, ExploreToolMatch[]>();
    for (const t of this.cachedResult.tools) {
      const existing = adapterMap.get(t.adapter_id) || [];
      existing.push(t);
      adapterMap.set(t.adapter_id, existing);
    }

    // Sort adapters by best tool score
    const sorted = [...adapterMap.entries()].sort(
      (a, b) => Math.max(...b[1].map((t) => t.score)) - Math.max(...a[1].map((t) => t.score))

    );

    return sorted.map(([adapterId, tools]) => {
      const bestScore = Math.round(Math.max(...tools.map((t) => t.score)));
      const item = new ExploreTreeItem(
        "adapter-group",
        vscode.TreeItemCollapsibleState.Collapsed,
        adapterId,
        adapterId,
        undefined,
        undefined,
        undefined,
        this.extUri
      );
      item.description = `${tools.length} tools, best ${bestScore}%`;
      return item;
    });
  }
}
