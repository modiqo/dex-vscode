import * as vscode from "vscode";
import { DexClient } from "../client/dexClient";

type ItemKind = "action" | "status" | "empty" | "step-done" | "step-todo" | "step-active";

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

const STEPS: { label: string; desc: string }[] = [
  { label: "Install",     desc: "dex binary + runtime" },
  { label: "Sign In",     desc: "Registry account" },
  { label: "APIs",        desc: "Select adapters" },
  { label: "Credentials", desc: "API tokens" },
  { label: "Wire",        desc: "Connect AI tools" },
  { label: "Live Proof",  desc: "Test run" },
];

export class SetupTreeProvider implements vscode.TreeDataProvider<SetupItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private status: SetupStatus = "not-installed";
  private loaded = false;
  private checkpoint = 0;

  constructor(private client: DexClient) {}

  refresh(): void {
    this.loaded = false;
    this._onDidChange.fire();
  }

  setStatus(status: SetupStatus): void {
    this.status = status;
    this.loaded = true;
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
        this.checkpoint = 0;
      } else {
        this.checkpoint = await this.client.wizardCheckpoint();
        this.status = this.checkpoint === 6 ? "complete" : "needs-setup";
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
          new SetupItem("action", "How it works", {
            icon: "play-circle",
            description: "Visual tour",
            commandId: "modiqo.showTour",
          }),
        ];

      case "needs-setup": {
        const items: SetupItem[] = [];
        for (let i = 0; i < STEPS.length; i++) {
          const { label, desc } = STEPS[i];
          if (i < this.checkpoint) {
            // Completed step
            items.push(new SetupItem("step-done", label, {
              icon: "pass-filled",
              description: desc,
            }));
          } else if (i === this.checkpoint) {
            // Current step — clickable, opens wizard
            items.push(new SetupItem("step-active", label, {
              icon: "circle-large-outline",
              description: desc,
              commandId: "modiqo.openSetupWizard",
            }));
          } else {
            // Future step
            items.push(new SetupItem("step-todo", label, {
              icon: "circle-outline",
              description: desc,
            }));
          }
        }
        items.push(new SetupItem("action", "How it works", {
          icon: "play-circle",
          description: "Visual tour",
          commandId: "modiqo.showTour",
        }));
        return items;
      }

      case "complete":
        return [
          new SetupItem("status", "Setup complete", {
            icon: "check",
            description: "All configured",
          }),
          new SetupItem("action", "How it works", {
            icon: "play-circle",
            description: "Visual tour",
            commandId: "modiqo.showTour",
          }),
        ];
    }
  }
}
