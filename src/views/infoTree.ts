import * as vscode from "vscode";
import { DexClient } from "../client/dexClient";

type ItemKind = "title" | "detail" | "section" | "command";

interface CommandDef {
  label: string;
  args: string[];
}

const GRAMMAR_TOPICS: CommandDef[] = [
  { label: "query", args: ["grammar", "query"] },
  { label: "stdin", args: ["grammar", "stdin"] },
  { label: "lines", args: ["grammar", "lines"] },
  { label: "browser", args: ["grammar", "browser"] },
  { label: "http", args: ["grammar", "http"] },
  { label: "session", args: ["grammar", "session"] },
  { label: "iteration", args: ["grammar", "iteration"] },
  { label: "batch", args: ["grammar", "batch"] },
  { label: "display", args: ["grammar", "display"] },
  { label: "control", args: ["grammar", "control"] },
  { label: "export", args: ["grammar", "export"] },
  { label: "flow", args: ["grammar", "flow"] },
  { label: "composition", args: ["grammar", "composition"] },
  { label: "inject", args: ["grammar", "inject"] },
  { label: "workspace", args: ["grammar", "workspace"] },
  { label: "model", args: ["grammar", "model"] },
  { label: "debug", args: ["grammar", "debug"] },
  { label: "install", args: ["grammar", "install"] },
  { label: "powerpack", args: ["grammar", "powerpack"] },
  { label: "registry", args: ["grammar", "registry"] },
  { label: "deno", args: ["grammar", "deno"] },
];

const GRAMMAR_ALTERNATIVES: CommandDef[] = [
  { label: "jq", args: ["grammar", "jq"] },
  { label: "grep", args: ["grammar", "grep"] },
  { label: "sed", args: ["grammar", "sed"] },
  { label: "awk", args: ["grammar", "awk"] },
  { label: "bc", args: ["grammar", "bc"] },
  { label: "curl", args: ["grammar", "curl"] },
  { label: "base64", args: ["grammar", "base64"] },
];

const GUIDANCE_TOPICS: CommandDef[] = [
  { label: "agent", args: ["guidance", "agent"] },
  { label: "adapters essential", args: ["guidance", "adapters", "essential"] },
  { label: "browser essential", args: ["guidance", "browser", "essential"] },
  { label: "inference", args: ["guidance", "inference"] },
  { label: "typescript essential", args: ["guidance", "typescript", "essential"] },
  { label: "vault essential", args: ["guidance", "vault", "essential"] },
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

    if (opts?.icon) {
      this.iconPath = new vscode.ThemeIcon(opts.icon);
    }

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
    if (!element) {
      if (!this.loaded) {
        const info = await this.client.dexInfo();
        this.version = info.version;
        this.folder = info.folder;
        this.loaded = true;
      }

      const items: InfoItem[] = [
        new InfoItem("title", "Modiqo Context File System", { icon: "pulse" }),
      ];

      if (this.version) {
        items.push(new InfoItem("detail", "Version", { description: this.version, icon: "tag" }));
      }
      if (this.folder) {
        items.push(new InfoItem("detail", "Folder", { description: this.folder, icon: "folder" }));
      }

      items.push(new InfoItem("section", "Grammar", {
        icon: "symbol-keyword",
        collapsible: true,
        description: "Command reference",
      }));

      items.push(new InfoItem("section", "Alternatives", {
        icon: "arrow-swap",
        collapsible: true,
        description: "jq, grep, sed, awk, curl",
      }));

      items.push(new InfoItem("section", "Guidance", {
        icon: "compass",
        collapsible: true,
        description: "Agent steering guides",
      }));

      return items;
    }

    if (element.kind === "section") {
      const label = element.label as string;
      if (label === "Grammar") {
        return GRAMMAR_TOPICS.map(
          (t) => new InfoItem("command", t.label, { icon: "chevron-right", cmdArgs: t.args }),
        );
      }
      if (label === "Alternatives") {
        return GRAMMAR_ALTERNATIVES.map(
          (t) => new InfoItem("command", t.label, { icon: "chevron-right", cmdArgs: t.args }),
        );
      }
      if (label === "Guidance") {
        return GUIDANCE_TOPICS.map(
          (t) => new InfoItem("command", t.label, { icon: "chevron-right", cmdArgs: t.args }),
        );
      }
    }

    return [];
  }
}
