import * as vscode from "vscode";
import { DexClient, Flow } from "../client/dexClient";

export class FlowTreeItem extends vscode.TreeItem {
  constructor(
    public readonly flow: Flow,
    public readonly isOrg: boolean,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    private extUri?: vscode.Uri
  ) {
    super(isOrg ? flow.org : flow.name, collapsibleState);

    if (isOrg) {
      this.id = `flow-org-${flow.org}`;
      this.iconPath = new vscode.ThemeIcon("folder");
      this.contextValue = "flow-org";
    } else {
      this.id = `flow-${flow.org}-${flow.name}`;
      this.description = flow.adapter?.replace("adapter/", "") ?? flow.org;
      this.tooltip = new vscode.MarkdownString([
        `**${flow.name}**`,
        "",
        flow.description ?? "",
        "",
        `Path: \`${flow.path}\``,
        flow.adapter ? `Adapter: \`${flow.adapter}\`` : "",
      ].filter(Boolean).join("\n"));
      this.contextValue = "flow";

      if (this.extUri) {
        this.iconPath = {
          light: vscode.Uri.joinPath(this.extUri, "media", "light", "flow.svg"),
          dark: vscode.Uri.joinPath(this.extUri, "media", "dark", "flow.svg"),
        };
      }

      this.command = {
        command: "vscode.open",
        title: "Open Flow",
        arguments: [vscode.Uri.file(flow.path)],
      };
    }
  }
}

export class FlowTreeProvider
  implements vscode.TreeDataProvider<FlowTreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    FlowTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private flows: Flow[] = [];
  private extUri: vscode.Uri | undefined;

  constructor(private client: DexClient) {}

  setExtensionUri(uri: vscode.Uri): void {
    this.extUri = uri;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: FlowTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: FlowTreeItem): Promise<FlowTreeItem[]> {
    if (!element) {
      try {
        this.flows = await this.client.flowList();
      } catch {
        this.flows = [];
      }

      const orgs = [...new Set(this.flows.map((f) => f.org))];

      if (orgs.length === 1) {
        return this.flows.map(
          (f) =>
            new FlowTreeItem(f, false, vscode.TreeItemCollapsibleState.None, this.extUri)
        );
      }

      return orgs.map(
        (org) =>
          new FlowTreeItem(
            { org, name: "", path: "" },
            true,
            vscode.TreeItemCollapsibleState.Collapsed,
            this.extUri
          )
      );
    }

    if (element.isOrg) {
      const orgFlows = this.flows.filter((f) => f.org === element.flow.org);
      return orgFlows.map(
        (f) =>
          new FlowTreeItem(f, false, vscode.TreeItemCollapsibleState.None, this.extUri)
      );
    }

    return [];
  }
}
