import * as vscode from "vscode";
import { DexClient } from "../client/dexClient";
import { FlowTreeItem } from "../views/flowTree";

export function registerRunFlow(client: DexClient): vscode.Disposable {
  return vscode.commands.registerCommand(
    "modiqo.runFlow",
    async (item?: FlowTreeItem) => {
      let flowPath: string;

      if (item && !item.isOrg) {
        flowPath = item.flow.path;
      } else {
        // Pick from available flows
        const flows = await client.flowList();
        if (flows.length === 0) {
          vscode.window.showWarningMessage("No flows found.");
          return;
        }

        const picked = await vscode.window.showQuickPick(
          flows.map((f) => ({
            label: f.name,
            description: f.org,
            detail: f.path,
          })),
          { placeHolder: "Select a flow to run" }
        );

        if (!picked) {
          return;
        }
        flowPath = picked.detail!;
      }

      // Run in integrated terminal
      const terminal = vscode.window.createTerminal({
        name: `dex: ${flowPath.split("/").pop()}`,
      });
      terminal.show();
      terminal.sendText(
        `dex deno run --allow-all "${flowPath}"`
      );
    }
  );
}
