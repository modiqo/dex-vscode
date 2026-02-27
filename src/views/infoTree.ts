import * as vscode from "vscode";
import { DexClient } from "../client/dexClient";

type ItemKind = "title" | "detail";

class InfoItem extends vscode.TreeItem {
  constructor(
    public readonly kind: ItemKind,
    label: string,
    description?: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = kind;

    if (kind === "title") {
      this.iconPath = new vscode.ThemeIcon("database");
    } else {
      this.iconPath = new vscode.ThemeIcon("dash");
    }
  }
}

export class InfoTreeProvider implements vscode.TreeDataProvider<InfoItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private version = "";
  private folder = "";
  private loaded = false;

  constructor(private client: DexClient) {}

  refresh(): void {
    this.loaded = false;
    this._onDidChange.fire();
  }

  getTreeItem(el: InfoItem): vscode.TreeItem {
    return el;
  }

  async getChildren(): Promise<InfoItem[]> {
    if (!this.loaded) {
      const info = await this.client.dexInfo();
      this.version = info.version;
      this.folder = info.folder;
      this.loaded = true;
    }

    const items: InfoItem[] = [
      new InfoItem("title", "Modiqo Context File System"),
    ];

    if (this.version) {
      items.push(new InfoItem("detail", "Version", this.version));
    }
    if (this.folder) {
      items.push(new InfoItem("detail", "Folder", this.folder));
    }

    return items;
  }
}
