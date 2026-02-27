import * as vscode from "vscode";
import { DexClient } from "../client/dexClient";

type ItemKind = "title" | "detail" | "section" | "command";

interface CommandDef {
  label: string;
  args: string[];
  icon: string;
}

const GRAMMAR_TOPICS: CommandDef[] = [
  { label: "query", args: ["grammar", "query"], icon: "search" },
  { label: "stdin", args: ["grammar", "stdin"], icon: "terminal" },
  { label: "lines", args: ["grammar", "lines"], icon: "list-flat" },
  { label: "browser", args: ["grammar", "browser"], icon: "globe" },
  { label: "http", args: ["grammar", "http"], icon: "cloud" },
  { label: "session", args: ["grammar", "session"], icon: "history" },
  { label: "iteration", args: ["grammar", "iteration"], icon: "sync" },
  { label: "batch", args: ["grammar", "batch"], icon: "layers" },
  { label: "display", args: ["grammar", "display"], icon: "eye" },
  { label: "control", args: ["grammar", "control"], icon: "shield" },
  { label: "export", args: ["grammar", "export"], icon: "export" },
  { label: "flow", args: ["grammar", "flow"], icon: "zap" },
  { label: "composition", args: ["grammar", "composition"], icon: "git-merge" },
  { label: "inject", args: ["grammar", "inject"], icon: "database" },
  { label: "workspace", args: ["grammar", "workspace"], icon: "folder" },
  { label: "model", args: ["grammar", "model"], icon: "hubot" },
  { label: "debug", args: ["grammar", "debug"], icon: "debug" },
  { label: "install", args: ["grammar", "install"], icon: "desktop-download" },
  { label: "powerpack", args: ["grammar", "powerpack"], icon: "package" },
  { label: "registry", args: ["grammar", "registry"], icon: "server" },
  { label: "deno", args: ["grammar", "deno"], icon: "code" },
];

const GRAMMAR_ALTERNATIVES: CommandDef[] = [
  { label: "jq", args: ["grammar", "jq"], icon: "json" },
  { label: "grep", args: ["grammar", "grep"], icon: "search" },
  { label: "sed", args: ["grammar", "sed"], icon: "find-replace" },
  { label: "awk", args: ["grammar", "awk"], icon: "table" },
  { label: "bc", args: ["grammar", "bc"], icon: "symbol-number" },
  { label: "curl", args: ["grammar", "curl"], icon: "cloud" },
  { label: "base64", args: ["grammar", "base64"], icon: "lock" },
];

const GUIDANCE_TOPICS: CommandDef[] = [
  { label: "agent", args: ["guidance", "agent"], icon: "robot" },
  { label: "adapters essential", args: ["guidance", "adapters", "essential"], icon: "plug" },
  { label: "browser essential", args: ["guidance", "browser", "essential"], icon: "globe" },
  { label: "inference", args: ["guidance", "inference"], icon: "lightbulb" },
  { label: "typescript essential", args: ["guidance", "typescript", "essential"], icon: "code" },
  { label: "vault essential", args: ["guidance", "vault", "essential"], icon: "key" },
];

class InfoItem extends vscode.TreeItem {
  public readonly cmdArgs?: string[];

  constructor(
    public readonly kind: ItemKind,
    label: string,
    opts?: {
      description?: string;
      icon?: string;
      collapsible?: boolean;
      cmdArgs?: string[];
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
    this.cmdArgs = opts?.cmdArgs;

    const iconId = opts?.icon ?? (kind === "title" ? "database" : "dash");
    this.iconPath = new vscode.ThemeIcon(iconId);

    if (kind === "command" && opts?.cmdArgs) {
      this.command = {
        command: "modiqo.showReference",
        title: "Show Reference",
        arguments: [opts.cmdArgs],
      };
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

  async getChildren(element?: InfoItem): Promise<InfoItem[]> {
    // Root level
    if (!element) {
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
        items.push(new InfoItem("detail", "Version", { description: this.version }));
      }
      if (this.folder) {
        items.push(new InfoItem("detail", "Folder", { description: this.folder }));
      }

      items.push(new InfoItem("section", "Grammar", {
        icon: "book",
        collapsible: true,
        description: "Command reference",
      }));

      items.push(new InfoItem("section", "Alternatives", {
        icon: "replace",
        collapsible: true,
        description: "jq, grep, sed, awk, curl",
      }));

      items.push(new InfoItem("section", "Guidance", {
        icon: "mortar-board",
        collapsible: true,
        description: "Agent steering guides",
      }));

      return items;
    }

    // Children of sections
    if (element.kind === "section") {
      const label = element.label as string;
      if (label === "Grammar") {
        return GRAMMAR_TOPICS.map(
          (t) => new InfoItem("command", t.label, { icon: t.icon, cmdArgs: t.args }),
        );
      }
      if (label === "Alternatives") {
        return GRAMMAR_ALTERNATIVES.map(
          (t) => new InfoItem("command", t.label, { icon: t.icon, cmdArgs: t.args }),
        );
      }
      if (label === "Guidance") {
        return GUIDANCE_TOPICS.map(
          (t) => new InfoItem("command", t.label, { icon: t.icon, cmdArgs: t.args }),
        );
      }
    }

    return [];
  }
}
