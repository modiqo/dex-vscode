import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { DexClient } from "../client/dexClient";

interface WorkspaceInfo {
  name: string;
  dir: string;
  responseCount: number;
  strategy: string;
  endpoint: string;
  createdAt: string;
  isActive: boolean;
}

type WsNodeKind = "workspace" | "section" | "response";

export class WorkspaceTreeItem extends vscode.TreeItem {
  constructor(
    public readonly ws: WorkspaceInfo,
    public readonly kind: WsNodeKind,
    collapsible: vscode.TreeItemCollapsibleState,
    label: string,
    public readonly responseId?: string,
    private extUri?: vscode.Uri
  ) {
    super(label, collapsible);
    this.applyStyle();
  }

  private applyStyle(): void {
    switch (this.kind) {
      case "workspace":
        this.id = `ws-${this.ws.name}`;
        this.description = `${this.ws.responseCount} responses`;
        this.tooltip = new vscode.MarkdownString([
          `**${this.ws.name}**`,
          "",
          `| Field | Value |`,
          `|-------|-------|`,
          `| Strategy | ${this.ws.strategy} |`,
          `| Endpoint | ${this.ws.endpoint} |`,
          `| Responses | ${this.ws.responseCount} |`,
          `| Created | ${this.ws.createdAt} |`,
        ].join("\n"));
        this.iconPath = new vscode.ThemeIcon("window");
        this.contextValue = this.ws.isActive ? "workspace-active" : "workspace";
        break;

      case "section":
        this.contextValue = "ws-section";
        if ((this.label as string) === "Trace") {
          this.iconPath = new vscode.ThemeIcon("pulse");
          this.command = {
            command: "modiqo.showTrace",
            title: "Show Trace",
            arguments: [this.ws],
          };
        } else if ((this.label as string) === "Commands") {
          this.iconPath = new vscode.ThemeIcon("list-ordered");
          this.command = {
            command: "modiqo.showCommands",
            title: "Show Commands",
            arguments: [this.ws],
          };
        }
        break;

      case "response":
        this.iconPath = new vscode.ThemeIcon("json");
        this.contextValue = "ws-response";
        this.command = {
          command: "vscode.open",
          title: "Open Response",
          arguments: [
            vscode.Uri.file(
              path.join(this.ws.dir, ".dex", "responses", `${this.responseId}.json`)
            ),
          ],
        };
        break;
    }
  }
}

export class WorkspaceTreeProvider
  implements vscode.TreeDataProvider<WorkspaceTreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    WorkspaceTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private workspaces: WorkspaceInfo[] = [];
  private extUri: vscode.Uri | undefined;

  constructor(private client: DexClient) {}

  setExtensionUri(uri: vscode.Uri): void {
    this.extUri = uri;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: WorkspaceTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(
    element?: WorkspaceTreeItem
  ): Promise<WorkspaceTreeItem[]> {
    if (!element) {
      this.workspaces = this.discoverWorkspaces();
      if (this.workspaces.length === 0) {
        return [];
      }
      return this.workspaces.map(
        (ws) =>
          new WorkspaceTreeItem(
            ws, "workspace", vscode.TreeItemCollapsibleState.Collapsed,
            ws.name, undefined, this.extUri
          )
      );
    }

    if (element.kind === "workspace") {
      const ws = element.ws;
      const children: WorkspaceTreeItem[] = [];

      // Trace section
      children.push(new WorkspaceTreeItem(
        ws, "section", vscode.TreeItemCollapsibleState.None,
        "Trace", undefined, this.extUri
      ));

      // Commands section
      children.push(new WorkspaceTreeItem(
        ws, "section", vscode.TreeItemCollapsibleState.None,
        "Commands", undefined, this.extUri
      ));

      // Individual responses
      const responsesDir = path.join(ws.dir, ".dex", "responses");
      if (fs.existsSync(responsesDir)) {
        const files = fs.readdirSync(responsesDir)
          .filter((f) => f.startsWith("@") && f.endsWith(".json"))
          .sort((a, b) => {
            const na = parseInt(a.replace("@", "").replace(".json", ""), 10);
            const nb = parseInt(b.replace("@", "").replace(".json", ""), 10);
            return na - nb;
          });

        for (const file of files) {
          const rid = file.replace(".json", "");
          const filePath = path.join(responsesDir, file);
          let desc = "";
          try {
            const raw = fs.readFileSync(filePath, "utf-8");
            const data = JSON.parse(raw);
            const method = data.request?.body?.method || data.request?.body?.params?.name || "";
            const status = data.response?.status ?? "";
            desc = [method, status ? `${status}` : ""].filter(Boolean).join("  ");
          } catch { /* skip */ }

          const item = new WorkspaceTreeItem(
            ws, "response", vscode.TreeItemCollapsibleState.None,
            rid, rid, this.extUri
          );
          item.description = desc;
          children.push(item);
        }
      }

      return children;
    }

    return [];
  }

  /** Discover workspaces from ~/.dex/dex/workspaces/ */
  private discoverWorkspaces(): WorkspaceInfo[] {
    const wsRoot = path.join(os.homedir(), ".dex", "dex", "workspaces");
    if (!fs.existsSync(wsRoot)) {
      return [];
    }

    const dirs = fs.readdirSync(wsRoot).filter((d) => {
      const stateFile = path.join(wsRoot, d, ".dex", "state.json");
      return fs.existsSync(stateFile);
    });

    return dirs.map((d) => {
      const dir = path.join(wsRoot, d);
      const stateFile = path.join(dir, ".dex", "state.json");
      try {
        const raw = fs.readFileSync(stateFile, "utf-8");
        const state = JSON.parse(raw);

        const responsesDir = path.join(dir, ".dex", "responses");
        let responseCount = 0;
        if (fs.existsSync(responsesDir)) {
          responseCount = fs.readdirSync(responsesDir)
            .filter((f) => f.startsWith("@")).length;
        }

        const endpoint = Object.values(state.sessions || {})
          .map((s: unknown) => (s as { endpoint: string }).endpoint)
          .join(", ") || "—";

        return {
          name: state.workspace || d,
          dir,
          responseCount,
          strategy: state.strategy || "unknown",
          endpoint,
          createdAt: state.created_at || "",
          isActive: true,
        };
      } catch {
        return {
          name: d,
          dir,
          responseCount: 0,
          strategy: "unknown",
          endpoint: "—",
          createdAt: "",
          isActive: false,
        };
      }
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
