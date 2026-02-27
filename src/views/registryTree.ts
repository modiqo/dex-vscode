import * as vscode from "vscode";
import {
  DexClient,
  RegistryWhoami,
  RegistryAdapter,
  RegistrySkill,
} from "../client/dexClient";

type RegNodeKind =
  | "status"
  | "login-prompt"
  | "section"
  | "adapter"
  | "skill"
  | "loading";

export class RegistryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly kind: RegNodeKind,
    collapsible: vscode.TreeItemCollapsibleState,
    label: string,
    public readonly registryAdapter?: RegistryAdapter,
    public readonly registrySkill?: RegistrySkill,
    private extUri?: vscode.Uri
  ) {
    super(label, collapsible);
    this.applyStyle();
  }

  private applyStyle(): void {
    switch (this.kind) {
      case "loading":
        this.iconPath = new vscode.ThemeIcon(
          "loading~spin",
          new vscode.ThemeColor("progressBar.background")
        );
        this.contextValue = "registry-loading";
        break;

      case "status":
        this.iconPath = new vscode.ThemeIcon("verified");
        this.contextValue = "registry-status";
        break;

      case "login-prompt":
        this.iconPath = new vscode.ThemeIcon("sign-in");
        this.contextValue = "registry-login";
        this.command = {
          command: "modiqo.registryLogin",
          title: "Login",
        };
        break;

      case "section":
        this.contextValue = "registry-section";
        if ((this.label as string).startsWith("Adapters")) {
          this.iconPath = this.extUri
            ? {
                light: vscode.Uri.joinPath(this.extUri, "media", "light", "adapter.svg"),
                dark: vscode.Uri.joinPath(this.extUri, "media", "dark", "adapter.svg"),
              }
            : new vscode.ThemeIcon("plug");
        } else if ((this.label as string).startsWith("Flows")) {
          this.iconPath = this.extUri
            ? {
                light: vscode.Uri.joinPath(this.extUri, "media", "light", "flow.svg"),
                dark: vscode.Uri.joinPath(this.extUri, "media", "dark", "flow.svg"),
              }
            : new vscode.ThemeIcon("zap");
        }
        break;

      case "adapter":
        if (this.registryAdapter) {
          this.description = this.registryAdapter.fingerprint;
          this.tooltip = new vscode.MarkdownString([
            `**${this.registryAdapter.name}**`,
            "",
            this.registryAdapter.description,
            "",
            `| Field | Value |`,
            `|-------|-------|`,
            `| Fingerprint | \`${this.registryAdapter.fingerprint}\` |`,
            `| Visibility | ${this.registryAdapter.visibility} |`,
          ].join("\n"));
          this.iconPath = new vscode.ThemeIcon("package");
          this.contextValue = "registry-adapter";
          this.command = {
            command: "modiqo.showRegistryDetail",
            title: "Show Detail",
            arguments: [this.registryAdapter, "adapter"],
          };
        }
        break;

      case "skill":
        if (this.registrySkill) {
          this.description = this.registrySkill.adapters;
          this.tooltip = new vscode.MarkdownString([
            `**${this.registrySkill.name}**`,
            "",
            this.registrySkill.description,
            "",
            `| Field | Value |`,
            `|-------|-------|`,
            `| Adapters | ${this.registrySkill.adapters} |`,
            `| Visibility | ${this.registrySkill.visibility} |`,
          ].join("\n"));
          this.iconPath = new vscode.ThemeIcon("symbol-method");
          this.contextValue = "registry-skill";
          this.command = {
            command: "modiqo.showRegistryDetail",
            title: "Show Detail",
            arguments: [this.registrySkill, "skill"],
          };
        }
        break;
    }
  }
}

export class RegistryTreeProvider
  implements vscode.TreeDataProvider<RegistryTreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    RegistryTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private whoami: RegistryWhoami | null = null;
  public cachedAdapters: RegistryAdapter[] = [];
  public cachedSkills: RegistrySkill[] = [];
  private extUri: vscode.Uri | undefined;
  private loading = false;
  public dataLoaded = false;

  constructor(private client: DexClient) {}

  setExtensionUri(uri: vscode.Uri): void {
    this.extUri = uri;
  }

  refresh(): void {
    this.whoami = null;
    this.cachedAdapters = [];
    this.cachedSkills = [];
    this.loading = false;
    this.dataLoaded = false;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: RegistryTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(
    element?: RegistryTreeItem
  ): Promise<RegistryTreeItem[]> {
    if (!element) {
      return this.buildRoot();
    }

    if (element.kind === "section") {
      const label = element.label as string;
      if (label.startsWith("Adapters")) {
        return this.cachedAdapters.map(
          (a) =>
            new RegistryTreeItem(
              "adapter",
              vscode.TreeItemCollapsibleState.None,
              a.name,
              a,
              undefined,
              this.extUri
            )
        );
      }
      if (label.startsWith("Flows")) {
        return this.cachedSkills.map(
          (s) =>
            new RegistryTreeItem(
              "skill",
              vscode.TreeItemCollapsibleState.None,
              s.name,
              undefined,
              s,
              this.extUri
            )
        );
      }
    }

    return [];
  }

  private async buildRoot(): Promise<RegistryTreeItem[]> {
    // Phase 1: Check auth (fast — local token check)
    if (!this.whoami) {
      // Show spinner while checking auth
      if (!this.loading) {
        this.loading = true;
        this.loadAuthThenData();
        return [
          new RegistryTreeItem(
            "loading",
            vscode.TreeItemCollapsibleState.None,
            "Connecting to registry...",
            undefined,
            undefined,
            this.extUri
          ),
        ];
      }
    }

    // Not authenticated
    if (this.whoami && this.whoami.status !== "valid") {
      const expiredLabel =
        this.whoami.status === "expired"
          ? "Session expired — login to continue"
          : "Not authenticated";
      return [
        new RegistryTreeItem(
          "login-prompt",
          vscode.TreeItemCollapsibleState.None,
          expiredLabel,
          undefined,
          undefined,
          this.extUri
        ),
      ];
    }

    // Authenticated but data still loading
    if (this.whoami && !this.dataLoaded) {
      const items: RegistryTreeItem[] = [];

      const statusItem = new RegistryTreeItem(
        "status",
        vscode.TreeItemCollapsibleState.None,
        this.whoami.email,
        undefined,
        undefined,
        this.extUri
      );
      statusItem.description = `token ${this.whoami.status}`;
      statusItem.tooltip = this.buildStatusTooltip(this.whoami);
      items.push(statusItem);

      items.push(
        new RegistryTreeItem(
          "loading",
          vscode.TreeItemCollapsibleState.None,
          "Loading adapters...",
          undefined,
          undefined,
          this.extUri
        )
      );
      items.push(
        new RegistryTreeItem(
          "loading",
          vscode.TreeItemCollapsibleState.None,
          "Loading flows...",
          undefined,
          undefined,
          this.extUri
        )
      );

      return items;
    }

    // Fully loaded
    if (this.whoami) {
      return this.buildLoadedRoot(this.whoami);
    }

    return [];
  }

  /** Load auth status, then kick off data load in parallel */
  private async loadAuthThenData(): Promise<void> {
    try {
      this.whoami = await this.client.registryWhoami();
    } catch {
      this.whoami = {
        status: "error",
        email: "",
        tokenExpires: "",
        tokenIssued: "",
        registryUrl: "",
        connected: false,
      };
    }

    this.loading = false;

    if (this.whoami.status !== "valid") {
      this._onDidChangeTreeData.fire();
      return;
    }

    // Refresh to show "Loading adapters/flows..." spinners
    this._onDidChangeTreeData.fire();

    // Load adapters and skills in parallel
    const [adapters, skills] = await Promise.all([
      this.client.registryAdapterList("bootstrap"),
      this.client.registrySkillList("bootstrap"),
    ]);

    this.cachedAdapters = adapters;
    this.cachedSkills = skills;
    this.dataLoaded = true;

    // Final refresh with all data
    this._onDidChangeTreeData.fire();
  }

  private buildLoadedRoot(whoami: RegistryWhoami): RegistryTreeItem[] {
    const items: RegistryTreeItem[] = [];

    const statusItem = new RegistryTreeItem(
      "status",
      vscode.TreeItemCollapsibleState.None,
      whoami.email,
      undefined,
      undefined,
      this.extUri
    );
    statusItem.description = `token ${whoami.status}`;
    statusItem.tooltip = this.buildStatusTooltip(whoami);
    items.push(statusItem);

    items.push(
      new RegistryTreeItem(
        "section",
        vscode.TreeItemCollapsibleState.Collapsed,
        `Adapters (${this.cachedAdapters.length})`,
        undefined,
        undefined,
        this.extUri
      )
    );

    items.push(
      new RegistryTreeItem(
        "section",
        vscode.TreeItemCollapsibleState.Collapsed,
        `Flows (${this.cachedSkills.length})`,
        undefined,
        undefined,
        this.extUri
      )
    );

    return items;
  }

  private buildStatusTooltip(whoami: RegistryWhoami): vscode.MarkdownString {
    return new vscode.MarkdownString([
      `**Registry Session**`,
      "",
      `| Field | Value |`,
      `|-------|-------|`,
      `| Email | ${whoami.email} |`,
      `| Status | ${whoami.status} |`,
      `| Issued | ${whoami.tokenIssued} |`,
      `| Expires | ${whoami.tokenExpires} |`,
      `| Registry | ${whoami.registryUrl} |`,
      `| Connected | ${whoami.connected ? "yes" : "no"} |`,
    ].join("\n"));
  }
}
