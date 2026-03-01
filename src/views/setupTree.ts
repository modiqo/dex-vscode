import * as vscode from "vscode";
import { DexClient } from "../client/dexClient";

type ItemKind = "action" | "status" | "empty";

class SetupItem extends vscode.TreeItem {
  constructor(
    public readonly kind: ItemKind,
    label: string,
    opts?: {
      description?: string;
      icon?: string;
      commandId?: string;
    },
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = opts?.description;
    this.contextValue = kind;

    if (opts?.icon) {
      this.iconPath = new vscode.ThemeIcon(opts.icon);
    }

    if (opts?.commandId) {
      this.command = {
        command: opts.commandId,
        title: label,
      };
    }
  }
}

export type SetupStatus = "not-installed" | "needs-setup" | "complete";

export class SetupTreeProvider implements vscode.TreeDataProvider<SetupItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private status: SetupStatus = "not-installed";
  private loaded = false;

  constructor(private client: DexClient) {}

  refresh(): void {
    this.loaded = false;
    this._onDidChange.fire();
  }

  setStatus(status: SetupStatus): void {
    this.status = status;
    this.loaded = true; // skip async re-detection on next getChildren
    this._onDidChange.fire();
  }

  getStatus(): SetupStatus {
    return this.status;
  }

  getTreeItem(el: SetupItem): vscode.TreeItem {
    return el;
  }

  async getChildren(): Promise<SetupItem[]> {
    if (!this.loaded) {
      const available = await this.client.isAvailable();
      if (!available) {
        this.status = "not-installed";
      } else {
        // Check if setup is complete: has adapters + has at least one token
        const [adapters, tokens] = await Promise.all([
          this.client.adapterList(),
          this.client.tokenList(),
        ]);
        const hasAdapters = adapters.length > 0;
        const hasConfiguredTokens = tokens.some((t) => t.configured);
        this.status = hasAdapters && hasConfiguredTokens ? "complete" : "needs-setup";
      }
      this.loaded = true;
    }

    switch (this.status) {
      case "not-installed":
        return [
          new SetupItem("action", "Install dex", {
            icon: "cloud-download",
            description: "Download and install",
            commandId: "modiqo.installDex",
          }),
        ];

      case "needs-setup":
        return [
          new SetupItem("action", "Begin Setup", {
            icon: "rocket",
            description: "Configure adapters and auth",
            commandId: "modiqo.openSetupWizard",
          }),
        ];

      case "complete":
        return [
          new SetupItem("status", "Setup complete", {
            icon: "check",
            description: "All configured",
          }),
        ];
    }
  }
}
