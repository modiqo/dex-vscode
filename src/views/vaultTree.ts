import * as vscode from "vscode";
import { DexClient, VaultToken } from "../client/dexClient";

type ItemKind = "header" | "token" | "detail" | "empty";

class VaultItem extends vscode.TreeItem {
  constructor(
    public readonly kind: ItemKind,
    label: string,
    public readonly token?: VaultToken,
    opts?: {
      description?: string;
      icon?: string;
      collapsible?: boolean;
    },
  ) {
    super(
      label,
      opts?.collapsible
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.description = opts?.description;
    this.contextValue = kind;

    if (opts?.icon) {
      this.iconPath = new vscode.ThemeIcon(opts.icon);
    }
  }
}

export class VaultTreeProvider implements vscode.TreeDataProvider<VaultItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private tokens: VaultToken[] = [];
  private loaded = false;

  constructor(private client: DexClient) {}

  refresh(): void {
    this.loaded = false;
    this._onDidChange.fire();
  }

  getTreeItem(el: VaultItem): vscode.TreeItem {
    return el;
  }

  async getChildren(element?: VaultItem): Promise<VaultItem[]> {
    if (!element) {
      // Root level
      if (!this.loaded) {
        this.tokens = await this.client.vaultTokenList();
        this.loaded = true;
      }

      if (this.tokens.length === 0) {
        return [
          new VaultItem("empty", "No tokens stored", undefined, {
            icon: "lock",
            description: "run: dex token set <NAME>",
          }),
        ];
      }

      const items: VaultItem[] = [
        new VaultItem("header", "Vault", undefined, {
          icon: "shield",
          description: `${this.tokens.length} tokens stored`,
        }),
      ];

      for (const t of this.tokens) {
        const isExpired = t.expires_in === "expired";
        const isOauth = t.type === "oauth2";
        let icon = "lock";
        if (isOauth) { icon = "key"; }
        if (isExpired) { icon = "warning"; }

        items.push(
          new VaultItem("token", t.name, t, {
            icon,
            description: t.type,
            collapsible: true,
          }),
        );
      }

      return items;
    }

    // Expanded token — show details
    if (element.kind === "token" && element.token) {
      const t = element.token;
      const details: VaultItem[] = [];

      if (t.type !== "-") {
        details.push(
          new VaultItem("detail", "Type", undefined, {
            description: t.type,
            icon: "symbol-type-parameter",
          }),
        );
      }
      if (t.expires_in !== "-") {
        const isExpired = t.expires_in === "expired";
        details.push(
          new VaultItem("detail", "Expires", undefined, {
            description: t.expires_in,
            icon: isExpired ? "warning" : "clock",
          }),
        );
      }
      if (t.refresh !== "-") {
        details.push(
          new VaultItem("detail", "Refresh", undefined, {
            description: t.refresh,
            icon: "sync",
          }),
        );
      }
      if (t.created !== "-") {
        details.push(
          new VaultItem("detail", "Created", undefined, {
            description: t.created,
            icon: "calendar",
          }),
        );
      }
      if (t.description !== "-") {
        details.push(
          new VaultItem("detail", "Description", undefined, {
            description: t.description,
            icon: "note",
          }),
        );
      }

      return details;
    }

    return [];
  }
}
