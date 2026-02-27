import * as vscode from "vscode";
import { DexClient } from "./client/dexClient";

export class DexStatusBar {
  private item: vscode.StatusBarItem;
  private client: DexClient;

  constructor(client: DexClient) {
    this.client = client;
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      50
    );
    this.item.command = "workbench.view.extension.modiqo-explorer";
    this.item.show();
  }

  async refresh(): Promise<void> {
    const available = await this.client.isAvailable();
    if (!available) {
      this.item.text = "$(warning) dex: not found";
      this.item.tooltip =
        "dex binary not found on PATH. Configure modiqo.executablePath in settings.";
      return;
    }

    try {
      const adapters = await this.client.adapterList();
      const configured = adapters.filter((a) => a.has_token).length;
      const total = adapters.length;

      if (configured < total) {
        this.item.text = `$(warning) dex: ${configured}/${total} adapters`;
        this.item.tooltip = `${total - configured} adapter(s) missing tokens`;
      } else {
        this.item.text = `$(check) dex: ${total} adapters`;
        this.item.tooltip = "All adapters configured";
      }
    } catch {
      this.item.text = "$(circle-outline) dex";
      this.item.tooltip = "dex";
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
